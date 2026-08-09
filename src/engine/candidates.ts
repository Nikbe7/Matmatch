import type { Allergy, DietaryFlag } from "../schema/allergyDietary.js";
import type { IngredientSlot, RecipeTemplate } from "../schema/recipeTemplate.js";
import { isIngredientExcluded } from "./allergens.js";
import type { MealConstraints } from "./constraints.js";
import type { EngineData } from "./data.js";

// First slice of the Meal Engine: given what a meal has to satisfy, which recipe
// templates are safe to eat? Deterministic and total — no ranking, no scoring, no AI,
// no I/O. Everything downstream in Phase 1 (Tonight card, guided flow, shopping list)
// consumes this candidate set.
//
// Takes a MealConstraints, not a Household (#115). The distinction matters: a
// household is *who lives here*, while constraints are *what this meal must satisfy*,
// and since DECISION_LOG 2026-08-09 those are no longer the same thing. Because the
// only way to obtain a MealConstraints is constraints.ts's derivation, no caller can
// assemble a narrower or wider constraint set of its own — which is what stops
// Tonight, the guided flow and Tier 2 from ever disagreeing about what is safe.

export interface SlotSubstitution {
  // Position in the template's ingredient_slots[]; disambiguates otherwise
  // identical slots for downstream consumers (the shopping list needs to know
  // which slot was swapped, not just that one was).
  slot_index: number;
  slot: IngredientSlot;
  substitute_ingredient_id: string;
}

export interface CandidateTemplate {
  // The loaded template, by reference — never mutated, never cloned. Substitutions
  // are returned as data alongside it rather than applied into it.
  template: RecipeTemplate;
  substitutions: readonly SlotSubstitution[];
}

// `vegetarian` and `vegan` are authored per generation batch onto the template
// (DECISION_LOG 2026-07-31, derived fields) and filter on dietary_tags, not on
// ingredients. `high_protein_preference` is deliberately absent: it is a soft
// preference belonging to ranking (DECISION_LOG 2026-07-31, priority sliders), and
// hard-filtering on it here would silently shrink the candidate set.
const HARD_DIETARY_FLAGS: readonly DietaryFlag[] = ["vegetarian", "vegan"];

/**
 * Whether a dish's own dietary_tags satisfy the meal's hard dietary flags.
 * Exported (not just used by selectCandidateTemplates below) so Tier 2 generated
 * dishes (src/engine/generatedDish.ts, src/api/routes/dishGenerate.ts) apply the
 * exact same rule rather than a re-implementation that could drift from it — a
 * generated dish's dietary_tags can only ever be [] or ["high_protein_preference"]
 * (see generatedDish.ts's derivation comment), so this always fails a household
 * declaring vegetarian/vegan, correctly.
 */
export function passesHardDietaryFilter(
  dietaryTags: readonly DietaryFlag[],
  flags: readonly DietaryFlag[],
): boolean {
  return flags.filter((flag) => HARD_DIETARY_FLAGS.includes(flag)).every((flag) => dietaryTags.includes(flag));
}

function passesDietaryFilter(template: RecipeTemplate, flags: readonly DietaryFlag[]): boolean {
  return passesHardDietaryFilter(template.dietary_tags, flags);
}

/**
 * The id of an edible ingredient that can stand in for this slot's excluded
 * ingredient, or undefined if the slot cannot be rescued.
 *
 * Only groups whose `role` matches the slot's role are eligible (§5.5), and
 * `substitutable: false` suppresses swaps entirely regardless of group membership —
 * the template author's statement that this ingredient *is* the dish. Per
 * DECISION_LOG 2026-08-01 that is the case for every protein slot in the library.
 */
function findSubstitute(
  data: EngineData,
  slot: IngredientSlot,
  allergies: readonly Allergy[],
): string | undefined {
  if (!slot.substitutable) return undefined;

  const groups = data.substitutionGroupsByMemberIngredientId.get(slot.ingredient_id) ?? [];
  for (const group of groups) {
    if (group.role !== slot.role) continue;
    for (const memberId of group.member_ingredient_ids) {
      if (memberId === slot.ingredient_id) continue;
      // Edibility of a candidate member is always resolved through the verified
      // ingredient-allergen mapping — groups carry no allergen or dietary field
      // by design (§5.5).
      if (!isIngredientExcluded(data, memberId, allergies)) return memberId;
    }
  }

  // First match wins, in group-file then member order. Which member a household
  // would *prefer* is a ranking judgment driven by the session weight vector
  // (DECISION_LOG 2026-07-31), not a property of this filter.
  return undefined;
}

/**
 * Every recipe template these constraints allow, including those rescued by a
 * substitution. A template survives when every one of its slots resolves to an
 * edible ingredient; an excluded slot may be rescued by a substitution, and a
 * template may be rescued at several slots at once.
 */
export function selectCandidateTemplates(
  data: EngineData,
  constraints: MealConstraints,
): CandidateTemplate[] {
  const candidates: CandidateTemplate[] = [];

  for (const template of data.templates) {
    // Hardcoded to "dinner" rather than a parameter: Tonight is the only caller
    // today (#68) and no lunch surface exists yet to inform what that parameter's
    // shape should even be. If/when a lunch flow is built, this is the line to
    // parameterize — do not guess the interface ahead of that caller existing.
    if (!template.meal_types.includes("dinner")) continue;
    if (!passesDietaryFilter(template, constraints.dietary_flags)) continue;

    const substitutions: SlotSubstitution[] = [];
    let survives = true;

    for (const [slotIndex, slot] of template.ingredient_slots.entries()) {
      if (!isIngredientExcluded(data, slot.ingredient_id, constraints.allergies)) continue;

      const substituteId = findSubstitute(data, slot, constraints.allergies);
      if (substituteId === undefined) {
        survives = false;
        break;
      }

      substitutions.push({ slot_index: slotIndex, slot, substitute_ingredient_id: substituteId });
    }

    if (!survives) continue;

    // `template.cost_tier` is returned unchanged, including for templates rescued by
    // a substitution. The effective cost tier of a swapped meal is explicitly
    // undefined until the Meal Engine first has to render one — see DECISION_LOG
    // 2026-08-01 ("Substitutions are symmetric groups", the swap-drift section) and
    // ARCHITECTURE.md §5.5. This slice does not render a tier, so it does not make
    // that call and must not invent one here.
    candidates.push({ template, substitutions });
  }

  return candidates;
}
