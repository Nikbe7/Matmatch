import type { SubstitutionRef } from "../db/recipeInstructions.js";
import type { InstructionsPromptIngredient } from "../ai/instructionsPrompt.js";
import type { EngineData } from "../engine/data.js";
import type { RecipeTemplate } from "../schema/recipeTemplate.js";
import { HttpError } from "./httpError.js";

// Resolves a client-supplied substitution set against a template for the
// instructions endpoint. Deliberately separate from tonightIngredients.ts: that
// module trusts its input (substitutions computed server-side by the ranking
// engine, corrupt data is a bug); this one validates request input from an
// untrusted client, so an unknown slot_index or ingredient id is a 400, not a thrown
// 500. The `slot` object itself is always re-derived from the template here, never
// taken from the client, so a caller cannot smuggle in a mismatched role/slot.

/**
 * Throws HttpError(400) if any substitution names a slot_index outside the
 * template's ingredient_slots[], or an ingredient id absent from the catalog.
 */
export function validateSubstitutionRefs(
  engineData: EngineData,
  template: RecipeTemplate,
  substitutions: readonly SubstitutionRef[],
): void {
  for (const substitution of substitutions) {
    const slot = template.ingredient_slots[substitution.slot_index];
    if (!slot) {
      throw new HttpError(
        400,
        "invalid_substitution",
        `template "${template.id}" has no slot at index ${substitution.slot_index}`,
      );
    }
    if (!engineData.ingredientsById.has(substitution.substitute_ingredient_id)) {
      throw new HttpError(
        400,
        "invalid_substitution",
        `unknown ingredient id "${substitution.substitute_ingredient_id}"`,
      );
    }
  }
}

/**
 * One resolved {role, name} per slot, in slot order, using the substitute
 * ingredient where the request's substitution set names one and the template's own
 * ingredient otherwise. Call only after validateSubstitutionRefs has passed — a
 * missing catalog entry at that point is corrupt curated data, not a bad request,
 * and throws loudly rather than silently omitting a step's ingredient.
 */
export function buildEffectiveIngredients(
  engineData: EngineData,
  template: RecipeTemplate,
  substitutions: readonly SubstitutionRef[],
): InstructionsPromptIngredient[] {
  const substituteBySlotIndex = new Map(
    substitutions.map((substitution) => [substitution.slot_index, substitution.substitute_ingredient_id]),
  );

  return template.ingredient_slots.map((slot, index) => {
    const ingredientId = substituteBySlotIndex.get(index) ?? slot.ingredient_id;
    const ingredient = engineData.ingredientsById.get(ingredientId);
    if (!ingredient) {
      throw new Error(
        `instructions: no catalog entry for ingredient id "${ingredientId}" (template ${template.id})`,
      );
    }
    return { role: slot.role, name: ingredient.name };
  });
}
