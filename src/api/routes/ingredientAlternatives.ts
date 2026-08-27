import { Router } from "express";
import { z } from "zod";
import type { TokenVerifier } from "../../auth/verifyToken.js";
import type { Sql } from "../../db/client.js";
import { getHouseholdForOwner } from "../../db/households.js";
import { mealDiners } from "../../engine/constraints.js";
import type { EngineData } from "../../engine/data.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../httpError.js";
import { parseDinersFromQuery } from "../diners.js";
import { buildIngredientAlternatives, type IngredientAlternativesView } from "../ingredientAlternatives.js";

// #124: intent-filtered ingredient alternatives for the swap popover. A single GET,
// fetched once per popover open — the search box below the filters is answered from
// the same response's `searchPool` by filtering client-side (the #110 idiom), not by
// a request per keystroke. No AI path in this slice (#132): every candidate here
// comes from curated substitution groups, gated by the same deterministic allergy
// filter every other surface uses.

const QuerySchema = z.object({
  template: z.string().min(1),
  slot: z.string().regex(/^\d+$/, "slot must be a non-negative integer"),
  ingredient: z.string().min(1),
});

export function ingredientAlternativesRouter(
  sql: Sql,
  engineData: EngineData,
  verifyToken: TokenVerifier,
): Router {
  const router = Router();

  router.get("/api/ingredients/alternatives", requireAuth(verifyToken), async (req, res, next) => {
    try {
      const parsed = QuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new HttpError(400, "invalid_request", parsed.error.issues[0]?.message ?? "invalid query");
      }
      const { template: templateId, ingredient: currentIngredientId } = parsed.data;
      const slotIndex = Number(parsed.data.slot);

      const template = engineData.templates.find((candidate) => candidate.id === templateId);
      if (!template) {
        throw new HttpError(404, "template_not_found", `no recipe template "${templateId}"`);
      }

      const slot = template.ingredient_slots[slotIndex];
      if (!slot) {
        throw new HttpError(400, "invalid_slot", `template "${templateId}" has no slot at index ${slotIndex}`);
      }

      if (!engineData.ingredientsById.has(currentIngredientId)) {
        throw new HttpError(400, "invalid_ingredient", `unknown ingredient id "${currentIngredientId}"`);
      }

      const stored = await getHouseholdForOwner(sql, req.userId!);
      if (!stored) {
        throw new HttpError(
          404,
          "household_not_found",
          "no household exists for this user yet — create one first",
        );
      }

      const selectedDiners = parseDinersFromQuery((req.query as Record<string, unknown>).diners);
      const { constraints, portions } = mealDiners(stored.household.members, selectedDiners);

      const view = buildIngredientAlternatives(
        engineData,
        slot,
        currentIngredientId,
        portions,
      );

      res.status(200).json(view satisfies IngredientAlternativesView);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
