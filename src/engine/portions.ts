import type { Household } from "../schema/household.js";

// Portion math, deferred by schema/household.ts's comment until a caller actually
// needed it — the shopping list's "För N portioner" line is that caller.
// Deterministic, no AI, no I/O: the total adult-equivalent portions a household
// eats, summed straight from the curated portion_factor per member.

export function totalPortions(household: Pick<Household, "members">): number {
  return household.members.reduce((total, member) => total + member.portion_factor, 0);
}
