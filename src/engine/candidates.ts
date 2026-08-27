import { COST_TIER_ORDER } from "../tools/validation.js";
import type { DietaryFlag } from "../schema/allergyDietary.js";
import type { CostTier } from "../schema/ingredient.js";
import type { IngredientSlot, IngredientSlotRole, RecipeTemplate } from "../schema/recipeTemplate.js";
import { isIngredientUnknown } from "./catalog.js";
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
 * Every edible ingredient that can stand in for `currentIngredientId` in a slot of
 * the given role — every group whose role matches and whose members include
 * `currentIngredientId`, unioned and de-duplicated, in group-file then member order.
 * `currentIngredientId` itself is never included.
 *
 * Deliberately keyed on `currentIngredientId` rather than a slot's authored
 * `ingredient_id`: a slot's *current* ingredient may already be a substitution-rescue
 * or a household-initiated swap (#124), and offering "alternatives to what's on the
 * plate" has to traverse from there, not from what the template originally named.
 *
 * Extracted so both `findSubstitute` below (single rescue candidate) and #124's
 * ingredient-swap popover (every candidate) traverse the curated groups exactly once,
 * in exactly one place — a second traversal is how the two could quietly disagree
 * about which ingredients are interchangeable.
 */
export function substituteCandidateIds(
  data: EngineData,
  role: IngredientSlotRole,
  currentIngredientId: string,
): string[] {
  const groups = data.substitutionGroupsByMemberIngredientId.get(currentIngredientId) ?? [];
  const seen = new Set<string>([currentIngredientId]);
  const candidateIds: string[] = [];

  for (const group of groups) {
    if (group.role !== role) continue;
    for (const memberId of group.member_ingredient_ids) {
      if (seen.has(memberId)) continue;
      seen.add(memberId);
      // Edibility of a candidate member is always resolved through the verified
      // ingredient-allergen mapping — groups carry no allergen or dietary field
      // by design (§5.5).
      if (isIngredientUnknown(data, memberId)) continue;
      candidateIds.push(memberId);
    }
  }

  return candidateIds;
}

/**
 * The id of an edible ingredient that can stand in for this slot's excluded
 * ingredient, or undefined if the slot cannot be rescued.
 *
 * Only groups whose `role` matches the slot's role are eligible (§5.5), and
 * `substitutable: false` suppresses swaps entirely regardless of group membership —
 * the template author's statement that this ingredient *is* the dish. Per
 * DECISION_LOG 2026-08-01 that is the case for every protein slot in the library.
 *
 * First match wins, in group-file then member order (`substituteCandidateIds`'
 * order). Which member a household would *prefer* is a ranking judgment driven by
 * the session weight vector (DECISION_LOG 2026-07-31), not a property of this filter.
 */
function findSubstitute(
  data: EngineData,
  slot: IngredientSlot,
): string | undefined {
  if (!slot.substitutable) return undefined;
  return substituteCandidateIds(data, slot.role, slot.ingredient_id)[0];
}

/**
 * Every catalog member of any substitution group of the given role, regardless of
 * which group(s) `excludeIngredientId` itself belongs to — the wide pool #124's
 * ingredient-swap search box filters client-side (the #110 type-to-filter idiom),
 * as distinct from `substituteCandidateIds`' narrow pool (only groups that already
 * contain the current ingredient). "Valid for that slot's role" is answered from the
 * curated groups, never from `Ingredient.category` — the two vocabularies are
 * deliberately not interchangeable (recipeTemplate.ts's role-vs-category comment).
 */
export function roleSubstitutionPool(
  data: EngineData,
  role: IngredientSlotRole,
  excludeIngredientId: string,
): string[] {
  const seen = new Set<string>([excludeIngredientId]);
  const ids: string[] = [];

  for (const group of data.substitutionGroupsById.values()) {
    if (group.role !== role) continue;
    for (const memberId of group.member_ingredient_ids) {
      if (seen.has(memberId)) continue;
      seen.add(memberId);
      if (isIngredientUnknown(data, memberId)) continue;
      ids.push(memberId);
    }
  }

  return ids;
}

export interface CostTierClassifiedCandidates {
  /** Candidates whose curated `default_cost_tier` is strictly below `currentTier`. */
  cheaper: string[];
  /** Candidates whose curated `default_cost_tier` equals `currentTier`. */
  similar: string[];
}

/**
 * Splits a candidate set by curated cost tier relative to the ingredient currently in
 * the slot — the deterministic basis for #124's Billigare/Liknande filters. Never a
 * kronor figure (CLAUDE.md non-negotiable): only the three-tier vocabulary ever
 * reaches a household, and it is read straight off `Ingredient.default_cost_tier`,
 * never computed or estimated.
 */
export function classifyCostTier(
  data: EngineData,
  candidateIds: readonly string[],
  currentTier: CostTier,
): CostTierClassifiedCandidates {
  const cheaper: string[] = [];
  const similar: string[] = [];

  for (const id of candidateIds) {
    const ingredient = data.ingredientsById.get(id);
    // candidateIds always come from substituteCandidateIds/roleSubstitutionPool,
    // which only ever emit ids present in ingredientsById — this is defensive, not a
    // path a caller can reach.
    if (!ingredient) continue;

    const order = COST_TIER_ORDER[ingredient.default_cost_tier] - COST_TIER_ORDER[currentTier];
    if (order < 0) cheaper.push(id);
    else if (order === 0) similar.push(id);
  }

  return { cheaper, similar };
}

/** The first ingredient slot a template cannot be safely served with, unrescued. */
export interface UnsafeSlot {
  slotIndex: number;
  ingredientId: string;
}

/**
 * One template's outcome against one constraint set: either the rescued candidate,
 * or specifically *why* it does not survive — a missing hard dietary tag, or the
 * first slot no substitution could rescue. Never both.
 *
 * The three-way split exists for #133/diner-change: keeping the dish shown on
 * Tonight across a diner-set change, or explaining why it had to be replaced,
 * needs to ask this exact question of one template — the same question
 * `selectCandidateTemplates` asks of every template in the catalog. A second,
 * parallel evaluation is exactly how the two could disagree about what is safe,
 * so both go through this one function.
 */
export type TemplateEvaluation =
  | { candidate: CandidateTemplate }
  | { missingDietaryFlags: readonly DietaryFlag[] };

/**
 * Whether `template` survives `constraints`, and if not, why — the single
 * implementation `selectCandidateTemplates` runs over the whole catalog, and the
 * diner-change flow (tonight.ts, guided.ts) runs directly against one template it
 * already has in hand.
 */
export function evaluateTemplateAgainstConstraints(
  data: EngineData,
  template: RecipeTemplate,
  constraints: MealConstraints,
): TemplateEvaluation {
  if (!passesDietaryFilter(template, constraints.dietary_flags)) {
    const missingDietaryFlags = HARD_DIETARY_FLAGS.filter(
      (flag) => constraints.dietary_flags.includes(flag) && !template.dietary_tags.includes(flag),
    );
    return { missingDietaryFlags };
  }

  // No slot loop since #224. Every substitution the engine ever generated was a rescue
  // of an allergy-excluded slot, and with allergy filtering gone there is nothing to
  // rescue: a template either passes the dietary filter or it does not. `substitutions`
  // stays on `CandidateTemplate` — empty from here — because the swap popover's applied
  // swaps travel the same field, and removing it is slice 2's job, not this one's.
  const substitutions: SlotSubstitution[] = [];

  // `template.cost_tier` is returned unchanged, including for templates rescued by
  // a substitution. The effective cost tier of a swapped meal is explicitly
  // undefined until the Meal Engine first has to render one — see DECISION_LOG
  // 2026-08-01 ("Substitutions are symmetric groups", the swap-drift section) and
  // ARCHITECTURE.md §5.5. This slice does not render a tier, so it does not make
  // that call and must not invent one here.
  return { candidate: { template, substitutions } };
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

    const evaluation = evaluateTemplateAgainstConstraints(data, template, constraints);
    if ("candidate" in evaluation) candidates.push(evaluation.candidate);
  }

  return candidates;
}
