import { describe, expect, it } from "vitest";
import { DIETARY_FLAGS } from "../schema/vocabulary.js";
import { HouseholdSchema, type HouseholdMember } from "../schema/household.js";
import { mealConstraints, mealDiners } from "./constraints.js";

function member(overrides: Partial<HouseholdMember> = {}): HouseholdMember {
  return { type: "adult", portion_factor: 1, dietary_flags: [], ...overrides };
}

describe("mealConstraints", () => {
  it("unions dietary flags across members", () => {
    const constraints = mealConstraints([
      member({ dietary_flags: ["vegetarian"] }),
      member({ dietary_flags: [] }),
      member({ dietary_flags: ["vegan"] }),
    ]);

    expect(constraints.dietary_flags).toEqual(["vegetarian", "vegan"]);
  });

  it("deduplicates a constraint two members share", () => {
    const constraints = mealConstraints([
      member({ dietary_flags: ["vegan"] }),
      member({ dietary_flags: ["vegan"] }),
    ]);

    expect(constraints.dietary_flags).toEqual(["vegan"]);
  });

  it("orders by the locked §5.2 vocabulary, not by the order members are listed in", () => {
    // The property that makes behavior preservation an equality assertion rather than
    // a set comparison — and that keeps the value safe to compare or key on later.
    const forwards = mealConstraints([
      member({ dietary_flags: ["high_protein_preference"] }),
      member({ dietary_flags: ["vegan"] }),
    ]);
    const backwards = mealConstraints([
      member({ dietary_flags: ["vegan"] }),
      member({ dietary_flags: ["high_protein_preference"] }),
    ]);

    expect(forwards).toEqual(backwards);
    expect(forwards.dietary_flags).toEqual(["vegan", "high_protein_preference"]);
  });

  it("yields empty constraints for a household that declares nothing", () => {
    expect(mealConstraints([member(), member()])).toEqual({ dietary_flags: [] });
  });

  it("yields empty constraints for an empty member list, which callers must never reach from user input", () => {
    // Documented, not endorsed: a route taking a diner set from the client resolves
    // "none selected" to the full household *before* calling this (#112, fail-closed).
    // The function itself stays total rather than throwing, so the engine has no
    // opinion about how a caller got here.
    expect(mealConstraints([])).toEqual({ dietary_flags: [] });
  });

  it("unions every dietary flag in the locked vocabulary", () => {
    const constraints = mealConstraints(
      DIETARY_FLAGS.map((flag) => member({ dietary_flags: [flag] })),
    );

    expect(constraints.dietary_flags).toEqual([...DIETARY_FLAGS]);
  });
});

describe("the full household — behavior preservation across #115", () => {
  // The binding condition on that change: the union over every member must equal
  // exactly what the household-level array used to hold, so not one suggestion moves.
  // Each case below is a household profile as it existed before constraints moved onto
  // members, paired with the array that profile stored. #224 removed the allergy half
  // of this; the dietary half is untouched and still has to hold.
  const cases: { name: string; before: { dietary_flags: string[] } }[] = [
    { name: "no restrictions", before: { dietary_flags: [] } },
    { name: "one dietary flag", before: { dietary_flags: ["vegetarian"] } },
    {
      name: "the mixed profile the persistence tests use",
      before: { dietary_flags: ["vegetarian", "high_protein_preference"] },
    },
    { name: "every flag at once", before: { dietary_flags: [...DIETARY_FLAGS] } },
  ];

  it.each(cases)(
    "the migration's backfill — every member carrying the household's array — reproduces it exactly ($name)",
    ({ before }) => {
      // This mirrors the SQL backfill in 20260810000000_per_member_constraints.sql:
      // every member gets the household's array verbatim.
      const household = HouseholdSchema.parse({
        members: [
          { type: "adult", portion_factor: 1, ...before },
          { type: "adult", portion_factor: 0.9, ...before },
          { type: "child", portion_factor: 0.6, ...before },
        ],
      });

      expect(mealConstraints(household.members)).toEqual(before);
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
          ...before.dietary_flags.map((flag, index) => ({
            type: index % 2 === 0 ? "adult" : "child",
            portion_factor: 1,
            dietary_flags: [flag],
          })),
          // At least one member always exists, even for the no-restrictions case.
          { type: "adult", portion_factor: 1, dietary_flags: [] },
        ],
      });

      expect(mealConstraints(household.members)).toEqual(before);
    },
  );

  it("is exhaustive over the locked dietary vocabulary, one member each", () => {
    for (const flag of DIETARY_FLAGS) {
      const household = HouseholdSchema.parse({
        members: [
          { type: "adult", portion_factor: 1, dietary_flags: [flag] },
          { type: "child", portion_factor: 0.5, dietary_flags: [] },
        ],
      });

      expect(mealConstraints(household.members).dietary_flags).toEqual([flag]);
    }
  });
});

describe("mealDiners — constraints scoped to who is eating (#112)", () => {
  // Two people, one restriction each, so every assertion below can say *whose*
  // constraint survived rather than just how many did.
  const vegetarianAdult = member({ dietary_flags: ["vegetarian"] });
  const veganChild = member({
    type: "child",
    portion_factor: 0.5,
    dietary_flags: ["vegan"],
  });
  const roster = [vegetarianAdult, veganChild];

  describe("the default is provably every member", () => {
    it("with no selection, the diners are the member list itself", () => {
      const diners = mealDiners(roster);

      // Identity of the *set*, not a same-length coincidence: the resolved diners are
      // exactly the members handed in, in order.
      expect(diners.members).toEqual(roster);
      expect(diners.constraints).toEqual(mealConstraints(roster));
      expect(diners.portions).toBe(1.5);
    });

    it("is the whole household for every roster size, not just the two-member case", () => {
      for (let size = 1; size <= 8; size += 1) {
        const members = Array.from({ length: size }, (_, index) =>
          member({ dietary_flags: [DIETARY_FLAGS[index % DIETARY_FLAGS.length]!] }),
        );

        expect(mealDiners(members).members).toHaveLength(size);
        expect(mealDiners(members).constraints).toEqual(mealConstraints(members));
      }
    });

    it("selecting every member explicitly is the same answer as selecting none", () => {
      const all = new Set(roster.map((_, index) => index));

      expect(mealDiners(roster, all)).toEqual(mealDiners(roster));
    });
  });

  describe("a deselected member's constraints stop applying; a selected member's do not", () => {
    it("dropping the vegan child leaves vegetarian and drops vegan", () => {
      const { constraints } = mealDiners(roster, new Set([0]));

      expect(constraints.dietary_flags).toEqual(["vegetarian"]);
    });

    it("dropping the vegetarian adult leaves vegan and drops vegetarian", () => {
      const { constraints } = mealDiners(roster, new Set([1]));

      expect(constraints.dietary_flags).toEqual(["vegan"]);
    });

    it("is exhaustive over the locked dietary vocabulary, both directions", () => {
      // The claim in both of its halves, for every flag there is: the carrier's flag
      // is dropped when they are not eating, and kept when they are.
      for (const flag of DIETARY_FLAGS) {
        const carrier = member({ dietary_flags: [flag] });
        // The carrier in the middle, so a subset that drops them is not just a prefix.
        const members = [member(), carrier, member()];

        expect(mealDiners(members, new Set([0, 2])).constraints.dietary_flags).toEqual([]);
        expect(mealDiners(members, new Set([1])).constraints.dietary_flags).toEqual([flag]);
        expect(mealDiners(members, new Set([0, 1])).constraints.dietary_flags).toEqual([flag]);
      }
    });

    it("keeps a flag two members share when only one of them is deselected", () => {
      const members = [
        member({ dietary_flags: ["vegan"] }),
        member({ dietary_flags: ["vegan"] }),
        member({ dietary_flags: ["vegetarian"] }),
      ];

      expect(mealDiners(members, new Set([0, 2])).constraints.dietary_flags).toEqual([
        "vegetarian",
        "vegan",
      ]);
      expect(mealDiners(members, new Set([2])).constraints.dietary_flags).toEqual(["vegetarian"]);
    });

    it("still orders by the locked vocabulary, not by diner order", () => {
      const members = [
        member({ dietary_flags: ["high_protein_preference"] }),
        member({ dietary_flags: ["vegan"] }),
      ];

      expect(mealDiners(members, new Set([1, 0])).constraints.dietary_flags).toEqual([
        "vegan",
        "high_protein_preference",
      ]);
    });
  });

  describe("fail-closed: anything but a wholly valid subset means the full household", () => {
    const fullHousehold = mealDiners(roster);

    const invalid: { name: string; selection: ReadonlySet<number> | undefined }[] = [
      { name: "absent", selection: undefined },
      { name: "empty", selection: new Set() },
      { name: "one past the end", selection: new Set([2]) },
      { name: "far past the end", selection: new Set([99]) },
      { name: "negative", selection: new Set([-1]) },
      { name: "fractional", selection: new Set([0.5]) },
      { name: "NaN", selection: new Set([Number.NaN]) },
      { name: "Infinity", selection: new Set([Number.POSITIVE_INFINITY]) },
      // The case that matters most: a set that is *mostly* right. Filtering the bad
      // index out would answer with a one-person constraint set nobody asked for.
      { name: "one valid index and one out of range", selection: new Set([0, 7]) },
    ];

    it.each(invalid)("$name resolves to every member", ({ selection }) => {
      const diners = mealDiners(roster, selection);

      expect(diners.members).toEqual(roster);
      expect(diners.constraints.dietary_flags).toEqual(["vegetarian", "vegan"]);
      expect(diners).toEqual(fullHousehold);
    });

    it("never yields a smaller constraint set than the household's for any selection", () => {
      // The property behind every case above, stated once over a brute-force sweep of
      // selections including out-of-range ones: a diner set can only ever *drop* a
      // constraint by naming a valid subset, never by being wrong.
      const household = mealConstraints(roster);

      for (let bits = 0; bits < 1 << 4; bits += 1) {
        const selection = new Set(
          [0, 1, 2, 3].filter((index) => (bits & (1 << index)) !== 0),
        );
        const { constraints } = mealDiners(roster, selection);
        const valid = [...selection].every((index) => index < roster.length);

        if (!valid || selection.size === 0) {
          expect(constraints).toEqual(household);
        } else {
          expect(household.dietary_flags).toEqual(
            expect.arrayContaining([...constraints.dietary_flags]),
          );
        }
      }
    });
  });

  describe("portions follow the same diner set", () => {
    it("drops the deselected member's portion factor", () => {
      expect(mealDiners(roster, new Set([0])).portions).toBe(1);
      expect(mealDiners(roster, new Set([1])).portions).toBe(0.5);
      expect(mealDiners(roster).portions).toBe(1.5);
    });

    it("agrees with the constraint set about who is eating, for every subset", () => {
      // The coupling requirement 2 asks for, asserted rather than assumed: portions and
      // constraints are derived from one resolution, so they cannot describe different
      // groups of people.
      for (let bits = 1; bits < 1 << roster.length; bits += 1) {
        const selection = new Set(
          roster.map((_, index) => index).filter((index) => (bits & (1 << index)) !== 0),
        );
        const diners = mealDiners(roster, selection);

        expect(diners.portions).toBe(
          diners.members.reduce((total, eater) => total + eater.portion_factor, 0),
        );
        expect(diners.constraints).toEqual(mealConstraints(diners.members));
      }
    });
  });

  it("does not mutate the member list it is given", () => {
    const members = [
      member({ dietary_flags: ["vegetarian"] }),
      member({ dietary_flags: ["vegan"] }),
    ];
    const before = structuredClone(members);

    mealDiners(members, new Set([0]));

    expect(members).toEqual(before);
  });
});
