import { ALLERGIES, DIETARY_FLAGS, type Allergy, type DietaryFlag } from "../schema/vocabulary.js";
import type { Household, HouseholdMember } from "../schema/household.js";

// What a meal has to satisfy, derived from the people eating it.
//
// Since DECISION_LOG 2026-08-09 allergies and dietary flags live on the member
// (src/schema/household.ts), so every consumer needs the union rather than a stored
// field. This module is the only place that union is computed. That is the point:
// it is the single seam #112 parameterizes by diner set, so Tonight, the guided flow
// and Tier 2 generation cannot diverge on what is safe — there is no second
// `.flatMap()` anywhere for them to diverge in.
//
// Pure and total: no I/O, no clock, no AI, exactly like the rest of src/engine/.

export interface MealConstraints {
  allergies: readonly Allergy[];
  dietary_flags: readonly DietaryFlag[];
}

/**
 * Deduplicated, and ordered by the locked §5.2 vocabulary rather than by the order
 * members happen to be listed in.
 *
 * Vocabulary order, not insertion order, so the same set of people always produces a
 * byte-identical constraint set regardless of who was added to the profile first.
 * That is what lets "the union over every member equals what the household used to
 * store" be an equality assertion instead of a set comparison, and it keeps the value
 * safe to compare or key on later.
 */
function inVocabularyOrder<T>(vocabulary: readonly T[], selected: ReadonlySet<T>): T[] {
  return vocabulary.filter((value) => selected.has(value));
}

/**
 * The union of the given members' allergies and dietary flags.
 *
 * Takes the member list rather than a `Household` so that #112 can hand it a subset
 * without constructing a synthetic household — a shape that would be easy to build
 * wrongly at each call site. An empty member list yields empty constraints, which is
 * only reachable from a caller that has already decided nobody is eating; callers
 * that take a diner set from user input must resolve "none selected" to the full
 * household *before* calling this (fail-closed), never by passing `[]` here.
 */
export function mealConstraints(members: readonly HouseholdMember[]): MealConstraints {
  const allergies = new Set<Allergy>();
  const dietaryFlags = new Set<DietaryFlag>();

  for (const member of members) {
    for (const allergy of member.allergies) allergies.add(allergy);
    for (const flag of member.dietary_flags) dietaryFlags.add(flag);
  }

  return {
    allergies: inVocabularyOrder(ALLERGIES, allergies),
    dietary_flags: inVocabularyOrder(DIETARY_FLAGS, dietaryFlags),
  };
}

/**
 * The whole household's constraint set — every member eating.
 *
 * The default everywhere, and the only thing that exists until #112 lands: safety is
 * the default state, never something a user has to select (DECISION_LOG 2026-08-09,
 * condition 1).
 */
export function householdConstraints(household: Pick<Household, "members">): MealConstraints {
  return mealConstraints(household.members);
}
