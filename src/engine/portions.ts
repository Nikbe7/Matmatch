import type { HouseholdMember } from "../schema/household.js";

// Portion math, deferred by schema/household.ts's comment until a caller actually
// needed it — the shopping list's "För N portioner" line is that caller.
// Deterministic, no AI, no I/O: the total adult-equivalent portions a set of people
// eat, summed straight from the curated portion_factor per member.

/**
 * Takes the member list rather than a `Household`, and only the field it reads —
 * the same narrowing idiom as `SeasonalityData` and `AllergenResolutionData`.
 *
 * This is also what makes portions follow the diner set for free in #112: the same
 * subset that derives the meal's constraints derives its portions, so the two can
 * never disagree about who is eating.
 */
export function totalPortions(members: readonly Pick<HouseholdMember, "portion_factor">[]): number {
  return members.reduce((total, member) => total + member.portion_factor, 0);
}
