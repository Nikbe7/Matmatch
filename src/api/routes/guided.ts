import { Router } from "express";
import type { TokenVerifier } from "../../auth/verifyToken.js";
import type { Sql } from "../../db/client.js";
import { getRecentCookedMeals } from "../../db/cookedMeals.js";
import { getHouseholdForOwner } from "../../db/households.js";
import { selectCandidateTemplates } from "../../engine/candidates.js";
import { mealDiners } from "../../engine/constraints.js";
import type { EngineData } from "../../engine/data.js";
import {
  pickDirections,
  suggestMainIngredientId,
  type Direction,
  type MainIngredientChoice,
} from "../../engine/directions.js";
import {
  buildCookingHistory,
  rankCandidates,
  RECENCY_HISTORY_WINDOW_DAYS,
  type RecencyContext,
} from "../../engine/ranking.js";
import {
  buildDirectionSummary,
  buildExcludedMainIngredients,
  buildGuidedIngredients,
  buildMainIngredientOptions,
  buildPantryIngredientOptions,
  parseMainFromQuery,
  parsePantryFromQuery,
} from "../guidedCatalog.js";
import { intentParameters, parseIntentFromQuery } from "../guidedIntent.js";
import { parseDinersFromQuery } from "../diners.js";
import { memberLabels } from "../../schema/household.js";
import { HttpError } from "../httpError.js";
import { requireAuth } from "../middleware/auth.js";

// The guided quick-select flow's two endpoints (UX_FLOW §5). Same shape and
// conventions as tonight.ts: bearer auth, the household loaded from the caller's own
// row, the engine run as pure functions over already-loaded data, and an empty
// result returned as a 200 with a machine-readable `reason` rather than an error —
// §9 forbids dead-ending the household, so "nothing fits" is an answer, not a
// failure.
//
// Nothing in this router writes. In particular the pantry ingredient ids on the
// query string are read to order the direction set and then dropped: no table, no
// column, no analytics payload. That is the CLAUDE.md non-negotiable, asserted in
// guided.test.ts.

export interface GuidedDirectionView {
  template: Direction["template"];
  substitutions: Direction["substitutions"];
  ingredients: ReturnType<typeof buildGuidedIngredients>;
  summary: string;
  score: number;
}

export function guidedRouter(sql: Sql, engineData: EngineData, verifyToken: TokenVerifier): Router {
  const router = Router();

  // Scoped to the household's own safe candidate set, not the whole catalog: a grid
  // built from all 170 templates offers a fish-allergic household "lax" as a tap
  // target whose only possible outcome is the §9 empty state. Filtering it out is not
  // the safety mechanism — `selectCandidateTemplates` below is, and it runs again on
  // every directions request — it just keeps the grid free of traps.
  router.get("/api/guided/options", requireAuth(verifyToken), async (req, res, next) => {
    try {
      const selectedDiners = parseDinersFromQuery((req.query as Record<string, unknown>).diners);

      const stored = await getHouseholdForOwner(sql, req.userId!);
      if (!stored) {
        throw new HttpError(
          404,
          "household_not_found",
          "no household exists for this user yet — create one first",
        );
      }

      // The same diner set the directions request will run on. The two endpoints are
      // separate GETs, so nothing server-side can force that; the client is what makes
      // a divergent pair inexpressible (web/src/guidedClient.ts). Getting it wrong is
      // not a safety hole — `selectCandidateTemplates` runs again below on every
      // directions request — but it would offer a tap target whose only outcome is the
      // §9 empty state.
      const { constraints } = mealDiners(stored.household.members, selectedDiners);
      const candidates = selectCandidateTemplates(engineData, constraints);

      res.status(200).json({
        diners: memberLabels(stored.household.members).map((label) => ({ label })),
        mainIngredients: buildMainIngredientOptions(engineData, candidates),
        pantryIngredients: buildPantryIngredientOptions(engineData, candidates),
        // Step 2's filter-miss explanation (requirement 4) — scoped to the household's
        // own allergies, not the whole catalog's allergen data.
        excludedMainIngredients: buildExcludedMainIngredients(engineData, constraints.allergies),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/guided/directions", requireAuth(verifyToken), async (req, res, next) => {
    try {
      const query = req.query as Record<string, unknown>;
      const intent = parseIntentFromQuery(query.intent);
      const main = parseMainFromQuery(engineData, query.main);
      const pantryIngredientIds = parsePantryFromQuery(engineData, query.pantry);
      const selectedDiners = parseDinersFromQuery(query.diners);
      const { weights, preferHighProtein } = intentParameters(intent);

      const stored = await getHouseholdForOwner(sql, req.userId!);
      if (!stored) {
        throw new HttpError(
          404,
          "household_not_found",
          "no household exists for this user yet — create one first",
        );
      }

      // The only place the server clock is read, exactly as in tonight.ts: the engine
      // stays pure and takes `month` and `now` as plain parameters.
      const now = new Date();
      const month = now.getMonth() + 1;

      const history = await getRecentCookedMeals(
        sql,
        req.userId!,
        stored.id,
        RECENCY_HISTORY_WINDOW_DAYS,
      );
      const recency: RecencyContext = { history: buildCookingHistory(history), now };

      // The shared pipeline, unchanged and in the same order Tonight runs it. Only
      // the selection step below is specific to this flow.
      const { constraints, portions } = mealDiners(stored.household.members, selectedDiners);
      const candidates = selectCandidateTemplates(engineData, constraints);
      const ranked = rankCandidates(
        engineData,
        candidates,
        weights,
        month,
        constraints.dietary_flags,
        recency,
      );

      if (ranked.length === 0) {
        // The household's own constraints leave nothing at all — a different problem
        // from "this main ingredient leaves nothing", and it needs a different way
        // out, so the client gets a distinct reason rather than one empty state
        // standing for both.
        res.status(200).json({
          directions: [],
          reason: "no_safe_templates",
          mainIngredientId: null,
          portions,
        });
        return;
      }

      // "Föreslå åt mig" and "Överraska mig" resolve here, against the ranked set the
      // household would have seen anyway — season, cost tier and history are already
      // in that score, so the suggestion is that score read back rather than a second
      // opinion about what is worth cooking.
      const suggestedId = main.kind === "auto" ? suggestMainIngredientId(ranked) : undefined;
      const mainChoice: MainIngredientChoice =
        main.kind === "ingredient"
          ? { kind: "ingredient", ingredientId: main.ingredientId }
          : suggestedId !== undefined
            ? { kind: "ingredient", ingredientId: suggestedId }
            : // `any` both for an explicit loosen request and for the case where the
              // best candidate has no protein or starch slot to suggest — showing the
              // best dishes we have beats showing none.
              { kind: "any" };

      const directions = pickDirections(ranked, {
        main: mainChoice,
        pantryIngredientIds,
        preferHighProtein,
      });

      const mainIngredientId =
        mainChoice.kind === "ingredient" ? mainChoice.ingredientId : null;

      if (directions.length === 0) {
        // Recoverable, and the common case rather than an edge case: a household with
        // allergies plus a chosen main ingredient runs out of options often. The
        // client renders the §9 loosen actions off this reason.
        res.status(200).json({
          directions: [],
          reason: "no_directions",
          mainIngredientId,
          portions,
        });
        return;
      }

      const views: GuidedDirectionView[] = directions.map((direction) => ({
        template: direction.template,
        substitutions: direction.substitutions,
        ingredients: buildGuidedIngredients(engineData, direction),
        summary: buildDirectionSummary(engineData, direction),
        score: direction.score,
      }));

      res.status(200).json({ directions: views, mainIngredientId, portions });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
