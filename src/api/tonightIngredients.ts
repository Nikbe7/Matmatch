import type { RankedCandidate } from "../engine/ranking.js";
import type { EngineData } from "../engine/data.js";
import { effectiveAllergens } from "../engine/allergens.js";
import type { Allergy } from "../schema/allergyDietary.js";
import { memberLabels, type HouseholdMember } from "../schema/household.js";
import type { IngredientSlotRole } from "../schema/recipeTemplate.js";
import { ALLERGIES } from "../schema/vocabulary.js";

// Display-shaping for the Tonight route only — not Meal Engine logic. The engine
// deals in ingredient ids; the card needs the curated Swedish name, which lives in
// the ingredient catalog the engine already has loaded. Resolving it here keeps
// src/engine/ ignorant of display concerns and keeps the response additive: the
// existing `template`/`substitutions` shape is untouched.

/**
 * One allergen a shopping-list ingredient carries, and who in the household it
 * affects (#116). Always the household's full member union, independent of any
 * diner set — a dish can legitimately be cooked while the allergic member is away,
 * and the ingredient still sits in the fridge afterwards.
 */
export interface IngredientAllergenMarking {
  allergy: Allergy;
  /** Labels of every member who declared this allergy — a name where they have one,
   * otherwise the derived "Vuxen 1"/"Barn 2" label. Always at least one entry. */
  members: string[];
}

export interface TonightIngredientView {
  role: IngredientSlotRole;
  // A resolved name string, never the full Ingredient row — embedding the row
  // would let the frontend start reading default_cost_tier/allergens off it and
  // reimplementing engine logic client-side (see issue #64).
  name: string;
  substituted: boolean;
  /** The household-union allergen marking for this ingredient — see #116. Empty when
   * no declared allergy of any member intersects this ingredient's allergens. */
  allergens: IngredientAllergenMarking[];
}

/**
 * Member labels grouped by the allergy they declared, in the locked §5.2 vocabulary
 * order — the same ordering discipline `mealConstraints` applies, so the same
 * household always produces byte-identical marking order.
 */
function membersByDeclaredAllergy(
  householdMembers: readonly HouseholdMember[],
): ReadonlyMap<Allergy, readonly string[]> {
  const labels = memberLabels(householdMembers);
  const byAllergy = new Map<Allergy, string[]>();

  householdMembers.forEach((member, index) => {
    for (const allergy of member.allergies) {
      const existing = byAllergy.get(allergy);
      if (existing) existing.push(labels[index]!);
      else byAllergy.set(allergy, [labels[index]!]);
    }
  });

  return byAllergy;
}

/**
 * Which of the household's declared allergies this ingredient carries.
 *
 * Reuses `effectiveAllergens` (§5.4) rather than re-deriving allergen data, so the
 * fail-safe rule — an unverified or missing row is treated as containing every
 * allergen — carries over unchanged: such a row marks whichever allergens the
 * household actually declared, exactly as `isIngredientExcluded` already treats it
 * for filtering, and never invents a softer "possibly" rule of its own. An
 * ingredient the household has no matching declared allergy for is never named for
 * a specific allergen, verified or not.
 */
function ingredientAllergenMarkings(
  engineData: EngineData,
  ingredientId: string,
  membersByAllergy: ReadonlyMap<Allergy, readonly string[]>,
): IngredientAllergenMarking[] {
  const contains = effectiveAllergens(engineData, ingredientId);
  const markings: IngredientAllergenMarking[] = [];

  for (const allergy of ALLERGIES) {
    if (!contains.has(allergy)) continue;
    const members = membersByAllergy.get(allergy);
    if (!members || members.length === 0) continue;
    markings.push({ allergy, members: [...members] });
  }

  return markings;
}

/**
 * One resolved ingredient view per slot, in slot order, using the substitute
 * ingredient where the filtering slice rescued the slot and the template's own
 * ingredient otherwise. Throws if a slot's ingredient id isn't in the loaded
 * catalog — that's corrupt curated data, not a request the caller can fix, and
 * must fail loudly rather than render an empty name.
 *
 * `householdMembers` must be the household's full member list, never a diner
 * subset (#116, DECISION_LOG 2026-08-09/-10) — allergen marking answers "who in
 * this home must not eat this," a question the evening's diner selection has no
 * bearing on.
 */
export function buildTonightIngredients(
  engineData: EngineData,
  candidate: Pick<RankedCandidate, "template" | "substitutions">,
  householdMembers: readonly HouseholdMember[],
): TonightIngredientView[] {
  const substituteBySlotIndex = new Map(
    candidate.substitutions.map((substitution) => [
      substitution.slot_index,
      substitution.substitute_ingredient_id,
    ]),
  );
  const membersByAllergy = membersByDeclaredAllergy(householdMembers);

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
      substituted: substituteId !== undefined,
      allergens: ingredientAllergenMarkings(engineData, ingredientId, membersByAllergy),
    };
  });
}
