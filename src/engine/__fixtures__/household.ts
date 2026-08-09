import { HouseholdSchema, type Household, type HouseholdMember } from "../../schema/household.js";
import type { Allergy, DietaryFlag } from "../../schema/allergyDietary.js";
import { householdConstraints, type MealConstraints } from "../constraints.js";

// Shared household fixtures for the engine and route tests.
//
// `makeHousehold` deliberately keeps the *old* household-level call shape —
// `{ allergies, dietary_flags }` — and lands those arrays on a single adult member.
// That is not nostalgia: it is what makes #115's behavior-preservation claim legible
// in the diff. Every existing test kept its inputs and its expectations verbatim and
// only changed where the arrays live, so a changed expectation anywhere in this
// change would stand out as a real behavior change rather than churn.
//
// Tests that care about *which* member holds a constraint pass `members` explicitly
// instead; that is the shape #112 exercises.

export interface HouseholdOverrides {
  members?: readonly Partial<HouseholdMember>[];
  /**
   * Landed on the first member — the one adult by default, or `members[0]` when a
   * roster is given. Composing rather than ignoring matters: a fixture that passes
   * both a roster and an allergy is asserting something about the *household's*
   * union, and silently dropping the allergy would weaken that test invisibly.
   */
  allergies?: readonly Allergy[];
  /** Landed on the first member, exactly as `allergies` is. */
  dietary_flags?: readonly DietaryFlag[];
}

export function makeHousehold(overrides: HouseholdOverrides = {}): Household {
  const roster = overrides.members ?? [{}];

  return HouseholdSchema.parse({
    members: roster.map((member, index) => ({
      type: "adult",
      portion_factor: 1,
      allergies: index === 0 ? (overrides.allergies ?? []) : [],
      dietary_flags: index === 0 ? (overrides.dietary_flags ?? []) : [],
      ...member,
    })),
  });
}

/** The household's full constraint set — every member eating, the engine default. */
export function makeConstraints(overrides: HouseholdOverrides = {}): MealConstraints {
  return householdConstraints(makeHousehold(overrides));
}
