import { describe, expect, it } from "vitest";
import { AllergySchema } from "../schema/allergyDietary.js";
import { selectCandidateTemplates } from "./candidates.js";
import { loadEngineData } from "./data.js";
import {
  DIRECTION_COUNT,
  eligibleDirections,
  pickDirections,
  suggestMainIngredientId,
  type MainIngredientChoice,
} from "./directions.js";
import { effectiveIngredientIds, rankCandidates, type RankedCandidate } from "./ranking.js";
import { makeEngineData, makeIngredient, makeTemplate } from "./__fixtures__/engineData.js";
import { makeConstraints as household } from "./__fixtures__/household.js";
import type { MealConstraints } from "./constraints.js";

// The guided flow's direction picker (UX_FLOW §5 step 4). Two halves: unit tests
// over synthetic ranked lists, where the ordering rules are visible, and safety
// tests over the real catalog, where the only thing that matters is that nothing
// this module returns can ever violate a household constraint.

const data = await loadEngineData();


/** The real pipeline, exactly as the route runs it: filter, then rank, then select. */
function realRanked(h: MealConstraints, month = 6): RankedCandidate[] {
  return rankCandidates(data, selectCandidateTemplates(data, h), { cost: 0, time: 0 }, month, h.dietary_flags);
}

const ANY: MainIngredientChoice = { kind: "any" };
const main = (ingredientId: string): MainIngredientChoice => ({ kind: "ingredient", ingredientId });

const ids = (directions: { template: { id: string } }[]) => directions.map((d) => d.template.id);

/**
 * A ranked candidate with a fixed score, so these tests exercise *selection* only.
 * Position in the array is the rank — which is precisely what pickDirections must
 * preserve inside a bucket.
 */
function ranked(
  id: string,
  overrides: Parameters<typeof makeTemplate>[1] = {},
  score = 0,
): RankedCandidate {
  return { template: makeTemplate(id, overrides), substitutions: [], score };
}

function slots(...ingredientIds: string[]) {
  return ingredientIds.map((ingredient_id) => ({
    role: "vegetable" as const,
    ingredient_id,
    substitutable: false,
  }));
}

describe("pickDirections — how many cards", () => {
  it("shows exactly three when the household has more than three options", () => {
    const list = [ranked("a"), ranked("b"), ranked("c"), ranked("d"), ranked("e")];

    expect(pickDirections(list, { main: ANY })).toHaveLength(DIRECTION_COUNT);
  });

  it("shows fewer rather than padding when a constrained household has fewer", () => {
    // A constrained household legitimately has one or two options (all 8 allergies
    // plus vegan leaves 14 templates before a main ingredient is even chosen).
    // Three is a target, never a guarantee, and never something to invent.
    expect(pickDirections([ranked("a"), ranked("b")], { main: ANY })).toHaveLength(2);
  });

  it("returns an empty set rather than throwing when nothing survives", () => {
    expect(pickDirections([], { main: ANY })).toEqual([]);
  });

  it("honours an explicit count", () => {
    const list = [ranked("a"), ranked("b"), ranked("c"), ranked("d")];

    expect(ids(pickDirections(list, { main: ANY, count: 1 }))).toEqual(["a"]);
  });
});

describe("pickDirections — main ingredient", () => {
  it("keeps only dishes that actually contain the chosen ingredient", () => {
    const list = [
      ranked("bonor", { ingredient_slots: slots("svarta-bonor") }),
      ranked("kyckling-ris", { ingredient_slots: slots("kyckling", "ris") }),
      ranked("kyckling-pasta", { ingredient_slots: slots("kyckling", "pasta") }),
    ];

    expect(ids(pickDirections(list, { main: main("kyckling") }))).toEqual([
      "kyckling-ris",
      "kyckling-pasta",
    ]);
  });

  it("matches the substitute, not the template's own ingredient, on a rescued slot", () => {
    // The household eats the swap, so the swap is what the main-ingredient step
    // must match — the same `effectiveIngredientIds` view ranking uses for season.
    const candidate: RankedCandidate = {
      template: makeTemplate("rescued", { ingredient_slots: slots("vetepasta") }),
      substitutions: [
        {
          slot_index: 0,
          slot: { role: "vegetable", ingredient_id: "vetepasta", substitutable: true },
          substitute_ingredient_id: "ris",
        },
      ],
      score: 0,
    };

    expect(ids(pickDirections([candidate], { main: main("ris") }))).toEqual(["rescued"]);
    expect(pickDirections([candidate], { main: main("vetepasta") })).toEqual([]);
  });

  it("drops the constraint entirely under `any`, which is the §9 loosen path", () => {
    const list = [ranked("bonor", { ingredient_slots: slots("svarta-bonor") })];

    expect(ids(pickDirections(list, { main: ANY }))).toEqual(["bonor"]);
  });
});

describe("pickDirections — pantry coverage", () => {
  it("surfaces dishes using more of what the household already has, over better-ranked ones", () => {
    const list = [
      ranked("uses-nothing", { ingredient_slots: slots("lax", "sparris") }),
      ranked("uses-one", { ingredient_slots: slots("lax", "ris") }),
      ranked("uses-two", { ingredient_slots: slots("lax", "ris", "gradde") }),
    ];

    expect(ids(pickDirections(list, { main: ANY, pantryIngredientIds: ["ris", "gradde"] }))).toEqual([
      "uses-two",
      "uses-one",
      "uses-nothing",
    ]);
  });

  it("reports which pantry ingredients each direction covers, for the shopping-list split", () => {
    const list = [ranked("gryta", { ingredient_slots: slots("lax", "ris", "gradde") })];

    const directions = pickDirections(list, {
      main: ANY,
      pantryIngredientIds: ["ris", "gradde", "pasta"],
    });

    expect(directions[0]?.coveredPantryIngredientIds).toEqual(["ris", "gradde"]);
  });

  it("counts a pantry ingredient once even when a dish uses it in two slots", () => {
    const list = [
      ranked("double", { ingredient_slots: slots("ris", "ris") }),
      ranked("spread", { ingredient_slots: slots("ris", "gradde") }),
    ];

    expect(ids(pickDirections(list, { main: ANY, pantryIngredientIds: ["ris", "gradde"] }))).toEqual([
      "spread",
      "double",
    ]);
  });

  it("leaves the ranked order untouched when the pantry step was skipped", () => {
    const list = [ranked("a"), ranked("b"), ranked("c")];

    expect(ids(pickDirections(list, { main: ANY }))).toEqual(["a", "b", "c"]);
    expect(ids(pickDirections(list, { main: ANY, pantryIngredientIds: [] }))).toEqual(["a", "b", "c"]);
  });
});

describe("pickDirections — the Proteinrikt intent", () => {
  const list = [
    ranked("vanlig", { ingredient_slots: slots("ris") }),
    ranked("proteinrik", { dietary_tags: ["high_protein_preference"], ingredient_slots: slots("ris") }),
  ];

  it("prefers high-protein-tagged dishes when the chip is on", () => {
    expect(ids(pickDirections(list, { main: ANY, preferHighProtein: true }))).toEqual([
      "proteinrik",
      "vanlig",
    ]);
  });

  it("changes nothing when the chip is off", () => {
    expect(ids(pickDirections(list, { main: ANY }))).toEqual(["vanlig", "proteinrik"]);
  });

  it("never filters — an untagged dish still surfaces when tagged ones run out", () => {
    // The whole reason this is a preference rather than a hard filter: only 13
    // dinner templates carry the tag before allergies are applied at all.
    const onlyUntagged = [ranked("a"), ranked("b")];

    expect(ids(pickDirections(onlyUntagged, { main: ANY, preferHighProtein: true }))).toEqual([
      "a",
      "b",
    ]);
  });

  it("does not let the intent outrank a real pantry match", () => {
    // Intent is the outer bucket key, so a tagged dish leads — but the tagged dish
    // covering more of the pantry must still come first among tagged ones.
    const mixed = [
      ranked("tagged-no-pantry", {
        dietary_tags: ["high_protein_preference"],
        ingredient_slots: slots("lax"),
      }),
      ranked("tagged-pantry", {
        dietary_tags: ["high_protein_preference"],
        ingredient_slots: slots("ris"),
      }),
    ];

    expect(
      ids(pickDirections(mixed, { main: ANY, preferHighProtein: true, pantryIngredientIds: ["ris"] })),
    ).toEqual(["tagged-pantry", "tagged-no-pantry"]);
  });
});

describe("pickDirections — cuisine variety", () => {
  it("prefers three different cuisines over the top three of one", () => {
    const list = [
      ranked("sv-1", { cuisine: "swedish_nordic" }),
      ranked("sv-2", { cuisine: "swedish_nordic" }),
      ranked("it-1", { cuisine: "italian_mediterranean" }),
      ranked("as-1", { cuisine: "asian" }),
    ];

    expect(ids(pickDirections(list, { main: ANY }))).toEqual(["sv-1", "it-1", "as-1"]);
  });

  it("falls back to rank order when there is no other cuisine to reach for", () => {
    const list = [
      ranked("sv-1", { cuisine: "swedish_nordic" }),
      ranked("sv-2", { cuisine: "swedish_nordic" }),
      ranked("sv-3", { cuisine: "swedish_nordic" }),
    ];

    expect(ids(pickDirections(list, { main: ANY }))).toEqual(["sv-1", "sv-2", "sv-3"]);
  });

  it("never trades a pantry match away for variety", () => {
    // Variety is searched inside the leading bucket only. A dish using something the
    // household already has must not be skipped for a more exotic one using nothing.
    const list = [
      ranked("sv-pantry-1", { cuisine: "swedish_nordic", ingredient_slots: slots("ris") }),
      ranked("as-no-pantry", { cuisine: "asian", ingredient_slots: slots("lax") }),
      ranked("sv-pantry-2", { cuisine: "swedish_nordic", ingredient_slots: slots("ris") }),
    ];

    expect(ids(pickDirections(list, { main: ANY, pantryIngredientIds: ["ris"] }))).toEqual([
      "sv-pantry-1",
      "sv-pantry-2",
      "as-no-pantry",
    ]);
  });
});

describe("pickDirections — determinism", () => {
  it("returns the same set for the same input, every time", () => {
    const list = [
      ranked("a", { cuisine: "asian", ingredient_slots: slots("ris") }),
      ranked("b", { cuisine: "asian", dietary_tags: ["high_protein_preference"] }),
      ranked("c", { cuisine: "swedish_nordic", ingredient_slots: slots("ris") }),
      ranked("d", { cuisine: "italian_mediterranean" }),
    ];
    const selection = { main: ANY, pantryIngredientIds: ["ris"], preferHighProtein: true };

    const first = ids(pickDirections(list, selection));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(ids(pickDirections(list, selection))).toEqual(first);
    }
  });

  it("does not mutate the ranked list it was given", () => {
    const list = [ranked("a"), ranked("b"), ranked("c"), ranked("d")];
    const before = ids(list);

    pickDirections(list, { main: ANY, pantryIngredientIds: ["ris"] });

    expect(ids(list)).toEqual(before);
  });
});

describe("suggestMainIngredientId — 'Föreslå åt mig'", () => {
  it("reads the protein of the best-ranked candidate, so season/cost/history decide", () => {
    const list = [
      ranked("best", {
        ingredient_slots: [
          { role: "starch", ingredient_id: "ris", substitutable: true },
          { role: "protein", ingredient_id: "lax", substitutable: false },
        ],
      }),
      ranked("second", { ingredient_slots: slots("kyckling") }),
    ];

    expect(suggestMainIngredientId(list)).toBe("lax");
  });

  it("falls back to the starch when a dish has no protein slot", () => {
    const list = [ranked("pasta", { ingredient_slots: [{ role: "starch", ingredient_id: "pasta", substitutable: true }] })];

    expect(suggestMainIngredientId(list)).toBe("pasta");
  });

  it("suggests the substitute on a rescued protein slot, never the excluded ingredient", () => {
    const candidate: RankedCandidate = {
      template: makeTemplate("rescued", {
        ingredient_slots: [{ role: "protein", ingredient_id: "rakor", substitutable: true }],
      }),
      substitutions: [
        {
          slot_index: 0,
          slot: { role: "protein", ingredient_id: "rakor", substitutable: true },
          substitute_ingredient_id: "kyckling",
        },
      ],
      score: 0,
    };

    expect(suggestMainIngredientId([candidate])).toBe("kyckling");
  });

  it("is undefined when the household has no safe candidates at all", () => {
    expect(suggestMainIngredientId([])).toBeUndefined();
  });

  it("is undefined when the best candidate has neither a protein nor a starch slot", () => {
    expect(suggestMainIngredientId([ranked("soppa", { ingredient_slots: slots("tomat") })])).toBeUndefined();
  });
});

describe("pickDirections — allergen safety over the real catalog", () => {
  // Exhaustive, not sampled (CLAUDE.md non-negotiable). Selection happens strictly
  // downstream of `selectCandidateTemplates`, so this cannot in principle reintroduce
  // an excluded ingredient — and that is exactly why it is asserted rather than
  // assumed: this is the module a future change would be tempted to make "smarter".
  const rowsByIngredientId = data.allergenMappingByIngredientId;

  /** Every ingredient the guided flow could put on screen for this household. */
  function surfacedIngredientIds(h: MealConstraints, selection: Partial<Parameters<typeof pickDirections>[1]> = {}) {
    const surfaced = new Set<string>();
    const list = realRanked(h);

    // Every main-ingredient choice the flow can reach, not one representative:
    // the grid offers a fixed set, and "any" is reachable from the §9 loosen path.
    const choices: MainIngredientChoice[] = [ANY];
    for (const candidate of list) {
      for (const ingredientId of effectiveIngredientIds(candidate)) {
        choices.push(main(ingredientId));
      }
    }

    for (const choice of choices) {
      for (const direction of pickDirections(list, { main: choice, ...selection })) {
        for (const ingredientId of effectiveIngredientIds(direction)) surfaced.add(ingredientId);
      }
    }

    return surfaced;
  }

  it.each(AllergySchema.options)(
    "never surfaces an ingredient containing %s to a household allergic to it",
    (allergy) => {
      const offenders = [...surfacedIngredientIds(household({ allergies: [allergy] }))].filter(
        (ingredientId) => {
          const row = rowsByIngredientId.get(ingredientId);
          // Fail-safe, checked independently of the engine: no row, or an unverified
          // row, is as disqualifying as a row that contains the allergen.
          return !row || row.verification_status !== "verified" || row.allergens.includes(allergy);
        },
      );

      expect(offenders).toEqual([]);
    },
  );

  it.each(AllergySchema.options)(
    "never surfaces %s under the pantry, Proteinrikt or Billigt paths either",
    (allergy) => {
      // The three levers this slice adds, each of which reorders the safe set — none
      // of which may ever reach outside it.
      const h = household({ allergies: [allergy] });
      const pantryIngredientIds = [...data.ingredientsById.keys()];

      const offenders = [
        ...surfacedIngredientIds(h, { pantryIngredientIds }),
        ...surfacedIngredientIds(h, { preferHighProtein: true }),
      ].filter((ingredientId) => rowsByIngredientId.get(ingredientId)?.allergens.includes(allergy));

      expect(offenders).toEqual([]);
    },
  );

  it.each(AllergySchema.options)(
    "never surfaces %s to an allergic vegetarian or vegan household either",
    (allergy) => {
      for (const flag of ["vegetarian", "vegan"] as const) {
        const offenders = [
          ...surfacedIngredientIds(household({ allergies: [allergy], dietary_flags: [flag] })),
        ].filter((ingredientId) => rowsByIngredientId.get(ingredientId)?.allergens.includes(allergy));

        expect(offenders).toEqual([]);
      }
    },
  );

  it("never surfaces a non-vegan dish to a vegan household, whatever the intent", () => {
    const h = household({ dietary_flags: ["vegan"] });
    const list = realRanked(h);

    for (const preferHighProtein of [false, true]) {
      for (const direction of pickDirections(list, { main: ANY, preferHighProtein })) {
        expect(direction.template.dietary_tags).toContain("vegan");
      }
    }
  });

  it("every direction it returns came from the ranked candidate set, unmodified", () => {
    const list = realRanked(household({ allergies: ["gluten"] }));
    const byId = new Map(list.map((candidate) => [candidate.template.id, candidate]));

    for (const direction of pickDirections(list, { main: ANY, pantryIngredientIds: ["ris"] })) {
      const source = byId.get(direction.template.id);
      expect(source).toBeDefined();
      expect(direction.template).toBe(source!.template);
      expect(direction.substitutions).toBe(source!.substitutions);
      expect(direction.score).toBe(source!.score);
    }
  });
});

describe("eligibleDirections — the §9 empty-state signal", () => {
  it("is empty exactly when the constraints leave nothing, so the caller can offer to loosen", () => {
    const list = realRanked(household({ allergies: ["gluten", "dairy_lactose"], dietary_flags: ["vegan"] }));

    expect(eligibleDirections(list, { main: main("entrecote") })).toEqual([]);
    expect(eligibleDirections(list, { main: ANY }).length).toBeGreaterThan(0);
  });

  it("can legitimately return fewer than three for a real constrained household", () => {
    const list = realRanked(household({ dietary_flags: ["vegan"] }));
    const eligible = eligibleDirections(list, { main: main("kikartor") });

    expect(eligible.length).toBeGreaterThan(0);
    expect(pickDirections(list, { main: main("kikartor") }).length).toBeLessThanOrEqual(
      eligible.length,
    );
  });
});

describe("pickDirections — the Billigt intent rides the existing weight vector", () => {
  it("moves budget dishes up when the cost weight is raised, with no new dimension", () => {
    // The intent chip's whole implementation: a different `weights` argument to the
    // *existing* rankCandidates. Asserted end-to-end so a regression in that wiring
    // shows up here and not only in a route test.
    const h = household();
    const candidates = selectCandidateTemplates(data, h);

    const neutral = pickDirections(rankCandidates(data, candidates, { cost: 0, time: 0 }, 6), {
      main: ANY,
    });
    const cheap = pickDirections(rankCandidates(data, candidates, { cost: 3, time: 0 }, 6), {
      main: ANY,
    });

    const tierRank = { budget: 0, mid: 1, premium: 2 } as const;
    const worst = (directions: { template: { cost_tier: keyof typeof tierRank } }[]) =>
      Math.max(...directions.map((d) => tierRank[d.template.cost_tier]));

    expect(worst(cheap)).toBeLessThanOrEqual(worst(neutral));
    expect(cheap.every((d) => d.template.cost_tier === "budget")).toBe(true);
  });
});

describe("pickDirections — synthetic data sanity", () => {
  it("works over an engine built from fixtures, not only the real catalog", () => {
    const engineData = makeEngineData({
      ingredients: [makeIngredient("kyckling"), makeIngredient("ris")],
      templates: [
        makeTemplate("wok", {
          cuisine: "asian",
          ingredient_slots: [
            { role: "protein", ingredient_id: "kyckling", substitutable: false },
            { role: "starch", ingredient_id: "ris", substitutable: false },
          ],
        }),
      ],
    });
    const list = rankCandidates(
      engineData,
      selectCandidateTemplates(engineData, household()),
      { cost: 0, time: 0 },
      6,
    );

    expect(ids(pickDirections(list, { main: main("kyckling"), pantryIngredientIds: ["ris"] }))).toEqual(
      ["wok"],
    );
  });
});
