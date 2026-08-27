import { evaluateTemplateAgainstConstraints, type TemplateEvaluation } from "../engine/candidates.js";
import type { MealConstraints } from "../engine/constraints.js";
import type { EngineData } from "../engine/data.js";
import type { RecipeTemplate } from "../schema/recipeTemplate.js";
import { memberLabels, type HouseholdMember } from "../schema/household.js";

// #133: which member a dish had to be replaced *for*, when a diner-set change
// leaves it unsafe. Lives here rather than in src/engine/ because it only ever
// runs after `evaluateTemplateAgainstConstraints` has already decided the dish is
// unsafe — it explains that decision in terms of the household, it does not make
// a second one. It never compares dietary flags to decide eligibility; that
// question stays answered exactly once, by the engine.

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
  return { template, affectedMemberLabel: affectedMemberLabel(evaluation, members, eating) };
}

/**
 * The eating member responsible for `evaluation`'s failure, or `undefined` when
 * the evaluation was itself safe (nothing to explain) or — defensively — when no
 * eating member's own declaration matches (should not happen: `constraints` is
 * always the union over `eating`, so whatever flag failed the dish belongs to at
 * least one of them).
 *
 * `members` is the full roster (label numbering is positional over the whole
 * roster, DECISION_LOG 2026-08-09), `eating` the diner subset the failing
 * `constraints` were derived from (`mealDiners`'s `.members`) — only a person
 * actually at tonight's table can be "the reason," even though the household as a
 * whole may have others with the same declared flag.
 */
export function affectedMemberLabel(
  evaluation: TemplateEvaluation,
  members: readonly HouseholdMember[],
  eating: readonly HouseholdMember[],
): string | undefined {
  // The allergy branch went with allergy filtering (#224). A dish can now only be
  // replaced *for a person* over a dietary flag, so that is the only reason there is
  // to name; the surviving `unknownSlotIngredient` outcome is a catalog fault nobody
  // at the table is responsible for, and falls through to `undefined` below.
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
