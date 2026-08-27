import { DIETARY_FLAGS, type DietaryFlag } from "../schema/vocabulary.js";
import type { HouseholdMember } from "../schema/household.js";
import { totalPortions } from "./portions.js";

// What a meal has to satisfy, derived from the people eating it.
//
// Dietary flags live on the member (src/schema/household.ts), so every consumer needs
// the union rather than a stored field. This module is the only place that union is
// computed, and it is the single seam #112 parameterizes by diner set, so Tonight, the
// guided flow and Tier 2 generation cannot diverge — there is no second `.flatMap()`
// anywhere for them to diverge in.
//
// Pure and total: no I/O, no clock, no AI, exactly like the rest of src/engine/. The
// diner set arrives as data — this module never parses a query string, and the HTTP
// shape of a diner selection lives entirely in src/api/diners.ts.

export interface MealConstraints {
  dietary_flags: readonly DietaryFlag[];
}

/**
 * Who is eating, as member positions in `household.members`.
 *
 * A member *is* its index (DECISION_LOG 2026-08-09, #115): the profile carries no
 * per-member id, so position is the only handle there is. Every way of being wrong
 * about that — an index out of range, a set built against a roster that has since
 * changed — resolves to the whole household below rather than to a smaller set.
 */
export type DinerSelection = ReadonlySet<number>;

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
 * The members a selection refers to — the whole list unless the selection names a
 * strict, wholly valid subset of it.
 *
 * Fail-closed, with no exceptions and no error path: absent, empty, or naming any
 * index that is not an integer position in `members` all resolve to everyone. The
 * safe answer is the *larger* constraint set, so "I could not make sense of this
 * selection" and "everyone is eating" are deliberately the same outcome — a
 * selection this cannot fully honour is one it must not partially honour, since a
 * partially-applied diner set silently drops somebody's dietary flag.
 *
 * That is also why this rejects the whole selection on one bad index rather than
 * filtering the bad ones out: dropping index 7 from `{0, 7}` would answer a question
 * nobody asked, with a smaller constraint set than either reading justifies.
 */
function dinerMembers(
  members: readonly HouseholdMember[],
  diners?: DinerSelection,
): readonly HouseholdMember[] {
  if (!diners || diners.size === 0) return members;

  for (const index of diners) {
    if (!Number.isInteger(index) || index < 0 || index >= members.length) return members;
  }

  return members.filter((_, index) => diners.has(index));
}

/**
 * The union of the given members' dietary flags.
 *
 * Takes the member list rather than a `Household` so that a subset needs no synthetic
 * household — a shape that would be easy to build wrongly at each call site.
 *
 * Deliberately *not* diner-aware: it takes people, not a selection. `mealDiners` below
 * is the only thing that resolves a diner set, so there is exactly one place a
 * selection can be interpreted and exactly one place that interpretation can be wrong.
 * An optional `diners` parameter here would be a second door to the same decision, and
 * a caller could reach one of them without the portions that must travel with it.
 *
 * An empty member list yields empty constraints: the function stays total rather than
 * throwing, and the engine has no opinion about how a caller got there. No caller can
 * reach it through a diner selection.
 */
export function mealConstraints(members: readonly HouseholdMember[]): MealConstraints {
  const dietaryFlags = new Set<DietaryFlag>();

  for (const member of members) {
    for (const flag of member.dietary_flags) dietaryFlags.add(flag);
  }

  return {
    dietary_flags: inVocabularyOrder(DIETARY_FLAGS, dietaryFlags),
  };
}

/** Everything a request needs to know about the people eating one meal. */
export interface MealDiners {
  /** The resolved diners — every member unless a valid subset was selected. */
  members: readonly HouseholdMember[];
  constraints: MealConstraints;
  /** Adult-equivalent portions for exactly those diners. */
  portions: number;
}

/**
 * The one entry point every surface uses. There is deliberately no other exported way
 * to obtain a constraint set for a request.
 *
 * Constraints and portions are derived here from a *single* resolution of the diner
 * set, which is the whole reason this exists rather than two calls at each route: a
 * caller never holds the subset, so it cannot filter for one set of people and cook
 * for another. Deselecting the child both stops applying their dietary flag and stops
 * buying their portion, and the two can't come apart.
 *
 * Passing no selection is the default everywhere, and answers for the whole
 * household: safety is the default state, never something a user has to select
 * (DECISION_LOG 2026-08-09, condition 1).
 */
export function mealDiners(
  members: readonly HouseholdMember[],
  diners?: DinerSelection,
): MealDiners {
  const eating = dinerMembers(members, diners);

  return {
    members: eating,
    // Both derived from `eating`, the single resolution — resolving the selection
    // twice would be two chances to resolve it differently.
    constraints: mealConstraints(eating),
    portions: totalPortions(eating),
  };
}
