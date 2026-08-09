import { Router } from "express";
import type { TokenVerifier } from "../../auth/verifyToken.js";
import type { Sql } from "../../db/client.js";
import { getHouseholdForOwner } from "../../db/households.js";
import { cookedTodayTemplateIds, getRecentCookedMeals } from "../../db/cookedMeals.js";
import { selectCandidateTemplates } from "../../engine/candidates.js";
import { householdConstraints } from "../../engine/constraints.js";
import type { EngineData } from "../../engine/data.js";
import {
  buildCookingHistory,
  pickNextSuggestion,
  rankCandidates,
  RECENCY_HISTORY_WINDOW_DAYS,
  type RecencyContext,
} from "../../engine/ranking.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../httpError.js";
import { parseWeightsFromQuery } from "../weights.js";
import { parseExcludeFromQuery, parsePreviousFromQuery } from "../tonightSelection.js";
import { buildTonightIngredients } from "../tonightIngredients.js";
import { totalPortions } from "../../engine/portions.js";

export function tonightRouter(sql: Sql, engineData: EngineData, verifyToken: TokenVerifier): Router {
  const router = Router();

  router.get("/api/tonight", requireAuth(verifyToken), async (req, res, next) => {
    try {
      const weights = parseWeightsFromQuery(req.query as Record<string, unknown>);
      const excludedTemplateIds = parseExcludeFromQuery((req.query as Record<string, unknown>).exclude);
      const previousTemplateId = parsePreviousFromQuery((req.query as Record<string, unknown>).previous);

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

      // Derived once and used for both filtering and ranking, so the two can never
      // be handed different answers about who this meal is for. #112 narrows this one
      // expression to the diner set; nothing else in this route changes.
      const constraints = householdConstraints(stored.household);

      const candidates = selectCandidateTemplates(engineData, constraints);
      const ranked = rankCandidates(
        engineData,
        candidates,
        weights,
        month,
        constraints.dietary_flags,
        recency,
      );
      const portions = totalPortions(stored.household.members);

      if (ranked.length === 0) {
        // Not an error: UX_FLOW §9 says never dead-end the user. A vegan+gluten
        // household hits this today (DECISION_LOG 2026-08-02, #46) and the client
        // needs a machine-readable reason to render "loosen constraints" rather than
        // treat this as a failed request.
        res.status(200).json({ result: null, reason: "no_safe_templates", portions });
        return;
      }

      // An unknown/stale previous id (e.g. from a household whose constraints
      // changed mid-session) simply matches nothing here — ignored, not rejected.
      const previousTemplate = previousTemplateId
        ? ranked.find((candidate) => candidate.template.id === previousTemplateId)?.template
        : undefined;
      const picked = pickNextSuggestion(ranked, excludedTemplateIds, previousTemplate);

      if (!picked) {
        // Distinct from no_safe_templates: the household has safe options, the
        // client has just already been shown all of them this session (#70).
        res.status(200).json({ result: null, reason: "no_more_suggestions", portions });
        return;
      }

      res.status(200).json({
        result: {
          template: picked.template,
          substitutions: picked.substitutions,
          ingredients: buildTonightIngredients(engineData, picked),
          score: picked.score,
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
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
