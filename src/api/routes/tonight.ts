import { Router } from "express";
import type { TokenVerifier } from "../../auth/verifyToken.js";
import type { Sql } from "../../db/client.js";
import { getHouseholdForOwner } from "../../db/households.js";
import { selectCandidateTemplates } from "../../engine/candidates.js";
import type { EngineData } from "../../engine/data.js";
import { pickNextSuggestion, rankCandidates } from "../../engine/ranking.js";
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
      // pure: month is a plain parameter, never a clock call made inside it.
      const month = new Date().getMonth() + 1;

      const candidates = selectCandidateTemplates(engineData, stored.household);
      const ranked = rankCandidates(engineData, candidates, weights, month);
      const portions = totalPortions(stored.household);

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
        },
        portions,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
