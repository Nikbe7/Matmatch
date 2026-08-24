import type { EngineData } from "./data.js";

// What the engine will and will not put on a plate. Replaces allergens.ts (#224):
// allergy filtering is gone, but one of that module's two fail-closed conditions was
// never about allergies and survives here on its own — and since #221 it is joined by
// the other question only the catalog can answer: whether two ingredients are the same
// product in different varieties.

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

/**
 * Whether two ingredients are varieties of the same everyday product (#221) — jasminris
 * and ris, matlagningsgrädde and vispgrädde.
 *
 * The narrow relation inside a substitution group, which encodes two different ones
 * under one name: varieties of one product, and different products that swap at the
 * stove. The swap popover (#124) wants the wide one; the pantry question wants this
 * one, because gul lök does not mean vitlök and telling a household it has garlic is
 * how they get to the stove without any.
 *
 * An ingredient with no key is a variety of nothing but itself: two ingredients that
 * both lack one are never varieties of each other, which is what keeps morot/rödbeta
 * and citron/lime apart. Reflexive on a known id, so callers can ask about an
 * ingredient and itself without a special case.
 *
 * Never a safety decision. This only decides ranking and display; a household's unsafe
 * dishes left the candidate set long before anything asks.
 */
export function isSameVariety(
  data: Pick<EngineData, "ingredientsById">,
  ingredientId: string,
  otherIngredientId: string,
): boolean {
  const variety = data.ingredientsById.get(ingredientId)?.variety_of;
  if (variety === undefined) return false;
  return variety === data.ingredientsById.get(otherIngredientId)?.variety_of;
}
