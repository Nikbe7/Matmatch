import type { RankedCandidate } from "../engine/ranking.js";
import type { EngineData } from "../engine/data.js";
import type { IngredientSlotRole } from "../schema/recipeTemplate.js";
import { scaleSlotQuantity, type ScaledQuantity } from "../engine/quantities.js";

// Display-shaping for the Tonight route only — not Meal Engine logic. The engine
// deals in ingredient ids; the card needs the curated Swedish name, which lives in
// the ingredient catalog the engine already has loaded. Resolving it here keeps
// src/engine/ ignorant of display concerns and keeps the response additive: the
// existing `template`/`substitutions` shape is untouched.

export interface TonightIngredientView {
  role: IngredientSlotRole;
  // A resolved name string, never the full Ingredient row — embedding the row
  // would let the frontend start reading default_cost_tier off it and
  // reimplementing engine logic client-side (see issue #64).
  name: string;
  /**
   * The slot's position in the template's ingredient_slots[] (#124). Identifies
   * which ingredient a tap targets when the client asks for swap alternatives —
   * never used by the client to read anything about the slot itself.
   */
  slotIndex: number;
  /**
   * The id of the ingredient currently filling this slot — the substitute if the
   * household swapped it, the template's own ingredient otherwise (#124).
   * A bare identifier only, not the catalog row: it lets the client ask "what else
   * could go here" without letting it read default_cost_tier off it directly (see
   * the `name` comment above, same rule).
   */
  ingredientId: string;
  substituted: boolean;
  /**
   * How much of it, already scaled to the diners eating tonight (#123). Structured
   * rather than a preformatted string, for the same reason `portions` is a raw
   * number: "600 g" vs "efter smak" is display wording the frontend owns and can
   * change without an API change.
   */
  quantity: ScaledQuantity;
}

/**
 * One resolved ingredient view per slot, in slot order, using the substitute
 * ingredient where the household swapped one in and the template's own ingredient
 * otherwise. Throws if a slot's ingredient id isn't in the loaded
 * catalog — that's corrupt curated data, not a request the caller can fix, and
 * must fail loudly rather than render an empty name.
 *
 * `portions` is exactly the diner subset's total (`mealDiners`): how
 * much to buy is precisely the question tonight's selection does bear on, so
 * deselecting the child stops buying their portion (#123).
 */
export function buildTonightIngredients(
  engineData: EngineData,
  candidate: Pick<RankedCandidate, "template" | "substitutions">,
  portions: number,
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

    return {
      role: slot.role,
      name: ingredient.name,
      slotIndex: index,
      ingredientId,
      substituted: substituteId !== undefined,
      // The *slot's* quantity, never the substitute ingredient's: a rescued slot
      // still has to fill the same hole in the dish, so swapping mandelmjölk for
      // mjölk changes what you buy, not how much (#123).
      quantity: scaleSlotQuantity(slot.quantity, portions),
    };
  });
}
