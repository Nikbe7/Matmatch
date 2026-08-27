import { Router } from "express";
import type { TokenVerifier } from "../../auth/verifyToken.js";
import type { Sql } from "../../db/client.js";
import { getHouseholdForOwner } from "../../db/households.js";
import { cookedTodayTemplateIds, getRecentCookedMeals } from "../../db/cookedMeals.js";
import { selectCandidateTemplates, type CandidateTemplate } from "../../engine/candidates.js";
import { mealDiners } from "../../engine/constraints.js";
import type { EngineData } from "../../engine/data.js";
import {
  buildCookingHistory,
  coveredPantryIngredientIds,
  explainSuggestion,
  pickNextSuggestion,
  rankCandidates,
  toRankingWeights,
  RECENCY_HISTORY_WINDOW_DAYS,
  type RecencyContext,
} from "../../engine/ranking.js";
import { orderByPantryCoverage } from "../../engine/directions.js";
import {
  buildPantryIngredientOptions,
  parsePantryFromQuery,
} from "../guidedCatalog.js";
import type { RecipeTemplate } from "../../schema/recipeTemplate.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../httpError.js";
import { parseWeightsDeltaFromQuery } from "../weights.js";
import { combinePreferenceWeights } from "../../schema/preferenceWeights.js";
import {
  parseExcludeFromQuery,
  parseKeepFromQuery,
  parsePreviousFromQuery,
} from "../tonightSelection.js";
import { buildTonightIngredients } from "../tonightIngredients.js";
import { parseDinersFromQuery } from "../diners.js";
import { explainReplacedDish } from "../dinerChangeReason.js";
import { memberLabels } from "../../schema/household.js";

/**
 * How many pantry ingredients the explanation line names before it stops (#152). Two,
 * because the line is prose on a card — "du har pasta och gul lök hemma" reads; a list
 * of five is an inventory, and the reference shows exactly two.
 */
const MAX_PANTRY_MATCH_NAMES = 2;

export function tonightRouter(sql: Sql, engineData: EngineData, verifyToken: TokenVerifier): Router {
  const router = Router();

  router.get("/api/tonight", requireAuth(verifyToken), async (req, res, next) => {
    try {
      // A session-scoped *delta* on the shared axes (#157), not a weight vector: the
      // household's persistent baseline comes from the database below, and the two are
      // combined once. Chips and sliders move the same four axes; only their lifetimes
      // differ.
      const weightsDelta = parseWeightsDeltaFromQuery(req.query as Record<string, unknown>);
      const excludedTemplateIds = parseExcludeFromQuery((req.query as Record<string, unknown>).exclude);
      const previousTemplateId = parsePreviousFromQuery((req.query as Record<string, unknown>).previous);
      // #133: the dish already on screen, sent only by a diner-set change — see
      // parseKeepFromQuery's own comment for how this differs from `previous`.
      const keepTemplateId = parseKeepFromQuery((req.query as Record<string, unknown>).keep);
      // Optional, and absent on the very first request of every session: Tonight is
      // zero-input and assumes everyone (DECISION_LOG 2026-08-09, condition 2).
      const selectedDiners = parseDinersFromQuery((req.query as Record<string, unknown>).diners);
      // #152: Tonight's own pantry row. Same parser, same contract and the same
      // ephemerality as the guided flow's step 3 — read to order the ranking, never
      // written to a table, a column or an analytics payload.
      const pantryIngredientIds = parsePantryFromQuery(
        engineData,
        (req.query as Record<string, unknown>).pantry,
      );

      const stored = await getHouseholdForOwner(sql, req.userId!);
      if (!stored) {
        throw new HttpError(
          404,
          "household_not_found",
          "no household exists for this user yet — create one first",
        );
      }

      // The only place the server clock is read in this slice. src/engine/ stays
      // pure: month and `now` are plain parameters, never clock calls made inside it.
      const now = new Date();
      const month = now.getMonth() + 1;

      // Repeat-avoidance input (#88). One query, bounded by the penalty window — the
      // route loads history and hands it to ranking as data; the client never sees it.
      const history = await getRecentCookedMeals(
        sql,
        req.userId!,
        stored.id,
        RECENCY_HISTORY_WINDOW_DAYS,
      );
      const recency: RecencyContext = { history: buildCookingHistory(history), now };

      // Baseline + delta → engine units, once, before anything ranks or explains. Every
      // use of `weights` below (ranking and both `explainSuggestion` calls) reads this
      // one value, so the card can never be ordered by one vector and explained by
      // another.
      const weights = toRankingWeights(
        combinePreferenceWeights(stored.preference_weights, weightsDelta),
      );

      // Derived once and used for filtering, ranking *and* portions, so none of the
      // three can be handed a different answer about who this meal is for. An
      // unparseable, empty or stale `diners` widens to the whole household here.
      const { members: eating, constraints, portions } = mealDiners(stored.household.members, selectedDiners);

      // Labels for the diner picker, by member position — never the members
      // themselves, so no allergy data crosses the wire and the client never holds a
      // second copy of the household. The client resets its selection whenever this
      // array changes, which is what keeps a position from outliving its roster.
      const diners = memberLabels(stored.household.members).map((label) => ({ label }));

      const candidates = selectCandidateTemplates(engineData, constraints);
      // Ordered by pantry coverage on top of the score, through the exact function the
      // guided flow's pantry step uses (#152) — one implementation, so the two screens
      // cannot come to different conclusions about what having pasta at home is worth.
      // An empty pantry is the identity, so a household that never taps a chip gets the
      // ranked order untouched. Everything downstream — the pick, the explanation and
      // the `keep` lookup — reads this one list, so no two of them can disagree.
      const ranked = orderByPantryCoverage(
        rankCandidates(engineData, candidates, weights, month, constraints.dietary_flags, recency),
        pantryIngredientIds,
      );

      // The chips themselves: the household's most likely staples, derived from the
      // same catalog frequency the guided flow's grid is built from. Sent with every
      // response so the row survives a reroll and a diner change without a second
      // request.
      const pantryIngredients = buildPantryIngredientOptions(engineData, candidates);

      /** The names behind a `pantry_match` reason, at most two (#152). */
      function pantryMatchNames(candidate: CandidateTemplate): string[] {
        return coveredPantryIngredientIds(candidate, new Set(pantryIngredientIds))
          .flatMap((id) => {
            const ingredient = engineData.ingredientsById.get(id);
            return ingredient ? [ingredient.name] : [];
          })
          .slice(0, MAX_PANTRY_MATCH_NAMES);
      }

      // #133: a diner-set change asks to *keep* the dish already on screen rather
      // than pick fresh. If it is still in the candidate set for the new
      // constraints, it is returned outright — the household never sees a dish it
      // did not ask for just because the ranking order shifted. If it is not, the
      // affected member is resolved here (from the raw catalog template, since an
      // unsafe dish never reaches `ranked`) and carried through as `replacedFor`,
      // and `previousTemplate` below still steers the fallback pick away from it —
      // the same diversity a reroll gets, on top of an honest explanation.
      let replacedFor: string | undefined;
      let previousTemplate: RecipeTemplate | undefined;

      if (keepTemplateId) {
        const kept = ranked.find((candidate) => candidate.template.id === keepTemplateId);

        if (kept) {
          // `excludedTemplateIds` always contains `kept.template.id` by the time a
          // diner change fires — the client adds every shown dish to `exclude` the
          // moment it appears, including this one, on the very request that first
          // showed it. Explaining a dish while it counts as its own exclusion would
          // drop it out of `explainSuggestion`'s `remaining` list entirely, so the
          // score-term comparison could never recognise it as the score's own
          // pick and would silently go quiet ("Valt för att …" disappearing on
          // every diner change that keeps the same dish, for no reason the
          // household did anything to deserve).
          const excludedForExplanation = new Set(excludedTemplateIds);
          excludedForExplanation.delete(kept.template.id);

          const reasonCodes = explainSuggestion(
            engineData,
            ranked,
            excludedForExplanation,
            kept,
            undefined,
            weights,
            month,
            constraints.dietary_flags,
            recency,
            pantryIngredientIds,
          );

          res.status(200).json({
            result: {
              template: kept.template,
              substitutions: kept.substitutions,
              ingredients: buildTonightIngredients(engineData, kept, portions),
              score: kept.score,
              reasonCodes,
              pantryMatch: reasonCodes.includes("pantry_match") ? pantryMatchNames(kept) : undefined,
              cookedToday: cookedTodayTemplateIds(history).has(kept.template.id),
            },
            portions,
            diners,
            pantryIngredients,
            preferenceWeights: stored.preference_weights,
          });
          return;
        }

        const explanation = explainReplacedDish(
          engineData,
          keepTemplateId,
          constraints,
          stored.household.members,
          eating,
        );
        if (explanation) {
          previousTemplate = explanation.template;
          replacedFor = explanation.affectedMemberLabel;
        }
      }

      if (ranked.length === 0) {
        // Not an error: UX_FLOW §9 says never dead-end the user. A vegan+gluten
        // household hits this today (DECISION_LOG 2026-08-02, #46) and the client
        // needs a machine-readable reason to render "loosen constraints" rather than
        // treat this as a failed request.
        res.status(200).json({
          result: null,
          reason: "no_safe_templates",
          portions,
          diners,
          pantryIngredients,
          preferenceWeights: stored.preference_weights,
          replacedFor,
        });
        return;
      }

      // An unknown/stale previous id (e.g. from a household whose constraints
      // changed mid-session) simply matches nothing here — ignored, not rejected.
      // `previousTemplate` may already be set above (the diner-change "keep"
      // path); `previous` is never sent alongside `keep` by the client, so the two
      // cannot disagree about which dish to diversify away from.
      const resolvedPrevious =
        previousTemplate ??
        (previousTemplateId
          ? ranked.find((candidate) => candidate.template.id === previousTemplateId)?.template
          : undefined);
      const picked = pickNextSuggestion(ranked, excludedTemplateIds, resolvedPrevious);

      if (!picked) {
        // Distinct from no_safe_templates: the household has safe options, the
        // client has just already been shown all of them this session (#70).
        res.status(200).json({
          result: null,
          reason: "no_more_suggestions",
          portions,
          diners,
          pantryIngredients,
          preferenceWeights: stored.preference_weights,
          replacedFor,
        });
        return;
      }

      // #122: why this dish, derived from the same ranked list and exclusion set
      // pickNextSuggestion just used, so it can never describe a different pick or a
      // different set of alternatives than what actually happened above.
      const reasonCodes = explainSuggestion(
        engineData,
        ranked,
        excludedTemplateIds,
        picked,
        resolvedPrevious,
        weights,
        month,
        constraints.dietary_flags,
        recency,
        pantryIngredientIds,
      );

      res.status(200).json({
        result: {
          template: picked.template,
          substitutions: picked.substitutions,
          ingredients: buildTonightIngredients(engineData, picked, portions),
          score: picked.score,
          reasonCodes,
          // Only ever present alongside the code that earns it — the client renders the
          // sentence from these names, so sending them without the code would be a
          // claim with nothing behind it.
          pantryMatch: reasonCodes.includes("pantry_match") ? pantryMatchNames(picked) : undefined,
          // One boolean about the dish on screen, not a history list: all the client
          // needs is to render the "Lagad ✓" state after a reload. A list of recent
          // meals would be API surface for the history screen that is explicitly out of
          // scope for #88 — history stays server-side, consumed by ranking above.
          // Answered from the history rows already read (the penalty window always
          // contains today), with the day boundary itself decided in SQL so it agrees
          // exactly with the `cooked_on` the idempotency constraint uses.
          cookedToday: cookedTodayTemplateIds(history).has(picked.template.id),
        },
        portions,
        diners,
        pantryIngredients,
        // The household's stored slider baseline, travelling with the suggestion it
        // ranked (#159) — so the block the client renders can never describe different
        // settings than the ones that produced the dish above it, and the screen needs
        // no second request to draw itself.
        preferenceWeights: stored.preference_weights,
        // Present only when the diner-change "keep" path above actually replaced a
        // dish — omitted (never `null`) otherwise, so the client's presence check
        // is the one place this ever gets read.
        replacedFor,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
