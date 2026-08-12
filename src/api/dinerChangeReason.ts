import { effectiveAllergens } from "../engine/allergens.js";
import { evaluateTemplateAgainstConstraints, type TemplateEvaluation } from "../engine/candidates.js";
import type { MealConstraints } from "../engine/constraints.js";
import type { EngineData } from "../engine/data.js";
import type { AllergenResolutionData } from "../engine/allergens.js";
import type { RecipeTemplate } from "../schema/recipeTemplate.js";
import { memberLabels, type HouseholdMember } from "../schema/household.js";

// #133: which member a dish had to be replaced *for*, when a diner-set change
// leaves it unsafe. Lives here rather than in src/engine/ because it only ever
// runs after `evaluateTemplateAgainstConstraints` has already decided the dish is
// unsafe — it explains that decision in terms of the household, it does not make
// a second one. It never compares allergy lists to decide safety; that question
// stays answered exactly once, by the engine.

export interface ReplacedDishExplanation {
  /** The raw catalog template a `keep` id named — never in `ranked`, or this
   * would not be running (tonight.ts/guided.ts only call this once a `keep`
   * lookup against the ranked/candidate set has already come up empty). */
  template: RecipeTemplate;
  affectedMemberLabel: string | undefined;
}

/**
 * Why a `keep` request's dish is not in this request's candidate set, resolved
 * from the raw catalog rather than `ranked` — an unsafe dish never reaches
 * `ranked`, so there is nothing there to explain from. `undefined` when
 * `keepTemplateId` does not name a real dinner template at all (a stale or
 * malformed id), which the caller must not describe as a replacement — that
 * would name a member for a swap that never had a real "before" dish.
 *
 * The `dinner` meal-type filter here mirrors `selectCandidateTemplates`'s own
 * (candidates.ts) exactly, and for the same reason a `keep` id can only ever
 * have come from a dinner template in the first place: both tonight.ts and
 * guided.ts only ever build `keep` from a dish that same server already served,
 * through `selectCandidateTemplates`.
 */
export function explainReplacedDish(
  data: EngineData,
  keepTemplateId: string,
  constraints: MealConstraints,
  members: readonly HouseholdMember[],
  eating: readonly HouseholdMember[],
): ReplacedDishExplanation | undefined {
  const template = data.templates.find(
    (candidate) => candidate.id === keepTemplateId && candidate.meal_types.includes("dinner"),
  );
  if (!template) return undefined;

  const evaluation = evaluateTemplateAgainstConstraints(data, template, constraints);
  return { template, affectedMemberLabel: affectedMemberLabel(data, evaluation, constraints, members, eating) };
}

/**
 * The eating member responsible for `evaluation`'s failure, or `undefined` when
 * the evaluation was itself safe (nothing to explain) or — defensively — when no
 * eating member's own declaration matches (should not happen: `constraints` is
 * always the union over `eating`, so whatever allergy or flag failed the dish
 * belongs to at least one of them).
 *
 * `members` is the full roster (label numbering is positional over the whole
 * roster, DECISION_LOG 2026-08-09), `eating` the diner subset the failing
 * `constraints` were derived from (`mealDiners`'s `.members`) — only a person
 * actually at tonight's table can be "the reason," even though the household as a
 * whole may have others with the same declared allergy.
 */
export function affectedMemberLabel(
  data: AllergenResolutionData,
  evaluation: TemplateEvaluation,
  constraints: MealConstraints,
  members: readonly HouseholdMember[],
  eating: readonly HouseholdMember[],
): string | undefined {
  if ("unsafeSlot" in evaluation) {
    const contains = effectiveAllergens(data, evaluation.unsafeSlot.ingredientId);
    const culpritAllergies = constraints.allergies.filter((allergy) => contains.has(allergy));
    return (
      firstMatchingMemberLabel(members, eating, (member) =>
        member.allergies.some((allergy) => culpritAllergies.includes(allergy)),
      ) ??
      // Fail-safe fallback (§5.4, allergens.ts): a slot can be unsafe for a
      // reason that traces to no single declared allergy — an ingredient
      // missing from the catalog entirely, which `isIngredientExcluded`
      // excludes regardless of allergies. `constraints.allergies` is only ever
      // non-empty here (an allergy-free household never reaches this branch —
      // `isIngredientExcluded` returns false outright when `allergies.length
      // === 0`), so naming the first eating member who has declared *any*
      // allergy is never a guess about who is eating; it is never silent.
      firstMatchingMemberLabel(members, eating, (member) => member.allergies.length > 0)
    );
  }

  if ("missingDietaryFlags" in evaluation) {
    const culpritFlags = evaluation.missingDietaryFlags;
    return firstMatchingMemberLabel(members, eating, (member) =>
      member.dietary_flags.some((flag) => culpritFlags.includes(flag)),
    );
  }

  return undefined;
}

function firstMatchingMemberLabel(
  members: readonly HouseholdMember[],
  eating: readonly HouseholdMember[],
  matches: (member: HouseholdMember) => boolean,
): string | undefined {
  const labels = memberLabels(members);

  for (const [index, member] of members.entries()) {
    if (!eating.includes(member)) continue;
    if (matches(member)) return labels[index];
  }

  return undefined;
}
