import { describe, expect, it } from "vitest";
import { ALLERGIES, DIETARY_FLAGS } from "../schema/vocabulary.js";
import { HouseholdSchema, type HouseholdMember } from "../schema/household.js";
import { householdConstraints, mealConstraints } from "./constraints.js";

function member(overrides: Partial<HouseholdMember> = {}): HouseholdMember {
  return { type: "adult", portion_factor: 1, allergies: [], dietary_flags: [], ...overrides };
}

describe("mealConstraints", () => {
  it("unions allergies and dietary flags across members", () => {
    const constraints = mealConstraints([
      member({ allergies: ["gluten"], dietary_flags: ["vegetarian"] }),
      member({ allergies: ["fish"], dietary_flags: [] }),
      member({ allergies: [], dietary_flags: ["vegan"] }),
    ]);

    expect(constraints.allergies).toEqual(["gluten", "fish"]);
    expect(constraints.dietary_flags).toEqual(["vegetarian", "vegan"]);
  });

  it("deduplicates a constraint two members share", () => {
    const constraints = mealConstraints([
      member({ allergies: ["peanuts"] }),
      member({ allergies: ["peanuts"] }),
    ]);

    expect(constraints.allergies).toEqual(["peanuts"]);
  });

  it("orders by the locked §5.2 vocabulary, not by the order members are listed in", () => {
    // The property that makes behavior preservation an equality assertion rather than
    // a set comparison — and that keeps the value safe to compare or key on later.
    const forwards = mealConstraints([
      member({ allergies: ["soy"], dietary_flags: ["vegan"] }),
      member({ allergies: ["gluten"], dietary_flags: ["high_protein_preference"] }),
    ]);
    const backwards = mealConstraints([
      member({ allergies: ["gluten"], dietary_flags: ["high_protein_preference"] }),
      member({ allergies: ["soy"], dietary_flags: ["vegan"] }),
    ]);

    expect(forwards).toEqual(backwards);
    expect(forwards.allergies).toEqual(["gluten", "soy"]);
    expect(forwards.dietary_flags).toEqual(["vegan", "high_protein_preference"]);
  });

  it("yields empty constraints for a household that declares nothing", () => {
    expect(mealConstraints([member(), member()])).toEqual({ allergies: [], dietary_flags: [] });
  });

  it("yields empty constraints for an empty member list, which callers must never reach from user input", () => {
    // Documented, not endorsed: a route taking a diner set from the client resolves
    // "none selected" to the full household *before* calling this (#112, fail-closed).
    // The function itself stays total rather than throwing, so the engine has no
    // opinion about how a caller got here.
    expect(mealConstraints([])).toEqual({ allergies: [], dietary_flags: [] });
  });

  it("carries the whole locked vocabulary when members between them declare all of it", () => {
    const constraints = mealConstraints(
      ALLERGIES.map((allergy) => member({ allergies: [allergy] })),
    );

    expect(constraints.allergies).toEqual([...ALLERGIES]);
  });

  it("unions every dietary flag in the locked vocabulary the same way", () => {
    const constraints = mealConstraints(
      DIETARY_FLAGS.map((flag) => member({ dietary_flags: [flag] })),
    );

    expect(constraints.dietary_flags).toEqual([...DIETARY_FLAGS]);
  });
});

describe("householdConstraints — behavior preservation across #115", () => {
  // The binding condition on this change: the union over every member must equal
  // exactly what the household-level arrays used to hold, so not one suggestion moves.
  // Each case below is a household profile as it existed before constraints moved onto
  // members, paired with the arrays that profile stored.
  const cases: { name: string; before: { allergies: string[]; dietary_flags: string[] } }[] = [
    { name: "no restrictions", before: { allergies: [], dietary_flags: [] } },
    { name: "one allergy", before: { allergies: ["gluten"], dietary_flags: [] } },
    { name: "one dietary flag", before: { allergies: [], dietary_flags: ["vegetarian"] } },
    {
      name: "the mixed profile the persistence tests use",
      before: { allergies: ["gluten", "fish"], dietary_flags: ["vegetarian"] },
    },
    {
      name: "every allergy and every flag at once",
      before: { allergies: [...ALLERGIES], dietary_flags: [...DIETARY_FLAGS] },
    },
  ];

  it.each(cases)(
    "the migration's backfill — every member carrying the household's arrays — reproduces them exactly ($name)",
    ({ before }) => {
      // This mirrors the SQL backfill in 20260810000000_per_member_constraints.sql:
      // every member gets the household's arrays verbatim.
      const household = HouseholdSchema.parse({
        members: [
          { type: "adult", portion_factor: 1, ...before },
          { type: "adult", portion_factor: 0.9, ...before },
          { type: "child", portion_factor: 0.6, ...before },
        ],
      });

      expect(householdConstraints(household)).toEqual(before);
    },
  );

  it.each(cases)(
    "splitting the same constraints across different members reproduces them too ($name)",
    ({ before }) => {
      // The shape onboarding will actually produce once a household can say who has
      // what: the union is identical, which is why #115 changes no suggestion even for
      // a profile edited after the migration.
      const household = HouseholdSchema.parse({
        members: [
          ...before.allergies.map((allergy, index) => ({
            type: index % 2 === 0 ? "adult" : "child",
            portion_factor: 1,
            allergies: [allergy],
            dietary_flags: [],
          })),
          ...before.dietary_flags.map((flag) => ({
            type: "adult",
            portion_factor: 1,
            allergies: [],
            dietary_flags: [flag],
          })),
          // At least one member always exists, even for the no-restrictions case.
          { type: "adult", portion_factor: 1, allergies: [], dietary_flags: [] },
        ],
      });

      expect(householdConstraints(household)).toEqual(before);
    },
  );

  it("is exhaustive over the locked allergy vocabulary, one member each", () => {
    for (const allergy of ALLERGIES) {
      const household = HouseholdSchema.parse({
        members: [
          { type: "adult", portion_factor: 1, allergies: [allergy], dietary_flags: [] },
          { type: "child", portion_factor: 0.5, allergies: [], dietary_flags: [] },
        ],
      });

      expect(householdConstraints(household).allergies).toEqual([allergy]);
    }
  });
});
