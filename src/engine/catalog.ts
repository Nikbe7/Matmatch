import type { EngineData } from "./data.js";

// What the engine will and will not put on a plate. Replaces allergens.ts (#224):
// allergy filtering is gone, but one of that module's two fail-closed conditions was
// never about allergies and survives here on its own.

/**
 * Whether the engine knows what this ingredient is.
 *
 * An id absent from the catalog has no name, no category, no quantity vocabulary and
 * no cost tier — nothing any downstream surface needs to render or reason about it.
 * It never reaches a dish, regardless of who is eating.
 *
 * Carried over verbatim from `isIngredientExcluded`'s first condition, which was
 * always separate from the allergen rule that shared the function with it: "we cannot
 * say what an unknown ingredient even is." Substitution groups and, later, AI-proposed
 * names are the paths that can carry one, so the check outlives the allergy path it
 * used to sit beside.
 *
 * This does not depend on the CLI validator having been run — the engine fails closed
 * on its own.
 */
export function isIngredientUnknown(
  data: Pick<EngineData, "ingredientsById">,
  ingredientId: string,
): boolean {
  return !data.ingredientsById.has(ingredientId);
}
