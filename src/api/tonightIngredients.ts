import type { RankedCandidate } from "../engine/ranking.js";
import type { EngineData } from "../engine/data.js";
import type { IngredientSlotRole } from "../schema/recipeTemplate.js";

// Display-shaping for the Tonight route only — not Meal Engine logic. The engine
// deals in ingredient ids; the card needs the curated Swedish name, which lives in
// the ingredient catalog the engine already has loaded. Resolving it here keeps
// src/engine/ ignorant of display concerns and keeps the response additive: the
// existing `template`/`substitutions` shape is untouched.

export interface TonightIngredientView {
  role: IngredientSlotRole;
  // A resolved name string, never the full Ingredient row — embedding the row
  // would let the frontend start reading default_cost_tier/allergens off it and
  // reimplementing engine logic client-side (see issue #64).
  name: string;
  substituted: boolean;
}

/**
 * One resolved ingredient view per slot, in slot order, using the substitute
 * ingredient where the filtering slice rescued the slot and the template's own
 * ingredient otherwise. Throws if a slot's ingredient id isn't in the loaded
 * catalog — that's corrupt curated data, not a request the caller can fix, and
 * must fail loudly rather than render an empty name.
 */
export function buildTonightIngredients(
  engineData: EngineData,
  candidate: Pick<RankedCandidate, "template" | "substitutions">,
): TonightIngredientView[] {
  const substituteBySlotIndex = new Map(
    candidate.substitutions.map((substitution) => [
      substitution.slot_index,
      substitution.substitute_ingredient_id,
    ]),
  );

  return candidate.template.ingredient_slots.map((slot, index) => {
    const substituteId = substituteBySlotIndex.get(index);
    const ingredientId = substituteId ?? slot.ingredient_id;
    const ingredient = engineData.ingredientsById.get(ingredientId);
    if (!ingredient) {
      throw new Error(
        `tonight response: no catalog entry for ingredient id "${ingredientId}" (template ${candidate.template.id})`,
      );
    }

    return { role: slot.role, name: ingredient.name, substituted: substituteId !== undefined };
  });
}
