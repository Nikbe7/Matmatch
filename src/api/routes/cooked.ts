import { Router } from "express";
import { z } from "zod";
import type { TokenVerifier } from "../../auth/verifyToken.js";
import type { Sql } from "../../db/client.js";
import { recordCookedMeal } from "../../db/cookedMeals.js";
import { getHouseholdForOwner } from "../../db/households.js";
import type { EngineData } from "../../engine/data.js";
import { validateSubstitutionRefs } from "../instructionsIngredients.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../httpError.js";

// The write half of repeat-avoidance (issue #88): one row per household/template/day,
// which Tonight's ranking then penalises for about two weeks. Called from "Laga
// ikväll" (#142, DECISION_LOG 2026-08-16) — choosing the dish, not a separate
// confirmation step — but this route's contract (and the table underneath it) is
// unaffected by what triggers the call.
//
// Idempotent by contract, not by best effort: a double tap answers 200 with the same
// `cookedAt` the first tap produced (the table's day constraint collapses them), so the
// client never has to reason about whether its own retry created a second row. A
// duplicate is deliberately NOT a 409 — the household did nothing wrong, and the
// end state is exactly what they asked for.

const SubstitutionRefSchema = z.object({
  slot_index: z.number().int().nonnegative(),
  substitute_ingredient_id: z.string().min(1),
});

const CookedRequestSchema = z.object({
  templateId: z.string().min(1),
  substitutions: z.array(SubstitutionRefSchema).default([]),
});

export interface CookedResponseBody {
  cooked: { templateId: string; cookedAt: string };
}

export function cookedRouter(sql: Sql, engineData: EngineData, verifyToken: TokenVerifier): Router {
  const router = Router();

  router.post("/api/cooked", requireAuth(verifyToken), async (req, res, next) => {
    try {
      const body = CookedRequestSchema.parse(req.body);

      const template = engineData.templates.find((candidate) => candidate.id === body.templateId);
      if (!template) {
        throw new HttpError(404, "template_not_found", `no recipe template "${body.templateId}"`);
      }

      // Validated rather than stored blindly: an unknown slot index or ingredient id
      // would be recorded as history that no later read could interpret, and the
      // instructions route already owns this check.
      validateSubstitutionRefs(engineData, template, body.substitutions);

      const stored = await getHouseholdForOwner(sql, req.userId!);
      if (!stored) {
        throw new HttpError(
          404,
          "household_not_found",
          "no household exists for this user yet — create one first",
        );
      }

      const cooked = await recordCookedMeal(
        sql,
        req.userId!,
        stored.id,
        template.id,
        body.substitutions,
      );

      res.status(200).json({
        cooked: {
          templateId: cooked.template_id,
          cookedAt: cooked.cooked_at.toISOString(),
        },
      } satisfies CookedResponseBody);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
