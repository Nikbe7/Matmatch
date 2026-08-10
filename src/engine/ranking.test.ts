import { describe, expect, it } from "vitest";
import { CostTierSchema } from "../schema/ingredient.js";
import { PrepTimeBandSchema } from "../schema/recipeTemplate.js";
import type { CandidateTemplate } from "./candidates.js";
import { selectCandidateTemplates } from "./candidates.js";
import { loadEngineData } from "./data.js";
import {
  buildCookingHistory,
  costTierIndex,
  explainSuggestion,
  familiarityIndex,
  inSeasonFraction,
  pickNextSuggestion,
  pickTonight,
  prepTimeIndex,
  rankCandidates,
  recencyPenalty,
  scoreCandidate,
  type RankingWeights,
  type RecencyContext,
} from "./ranking.js";
import { makeEngineData, makeIngredient, makeTemplate } from "./__fixtures__/engineData.js";
import { makeConstraints } from "./__fixtures__/household.js";

// Seasonality fixtures: "aret-runt" is always in season, "sommar" only in July.
const seasonalityData = makeEngineData({
  ingredients: [
    makeIngredient("aret-runt", { available_year_round: true, peak_months: [] }),
    makeIngredient("sommar", { available_year_round: false, peak_months: [7] }),
    makeIngredient("vinter", { available_year_round: false, peak_months: [1] }),
  ],
});

function candidate(
  id: string,
  overrides: Parameters<typeof makeTemplate>[1] = {},
  substitutions: CandidateTemplate["substitutions"] = [],
): CandidateTemplate {
  return { template: makeTemplate(id, overrides), substitutions };
}

/** A candidate with one always-in-season slot, so seasonality is constant across it. */
function neutralCandidate(id: string, overrides: Parameters<typeof makeTemplate>[1] = {}) {
  return candidate(id, {
    ingredient_slots: [{ role: "vegetable", ingredient_id: "aret-runt", substitutable: true }],
    ...overrides,
  });
}

const ids = (ranked: { template: { id: string } }[]) => ranked.map((r) => r.template.id);

describe("costTierIndex / prepTimeIndex", () => {
  it("gives every cost tier an ordinal, cheapest first", () => {
    expect(costTierIndex("budget")).toBe(0);
    expect(costTierIndex("mid")).toBe(1);
    expect(costTierIndex("premium")).toBe(2);
  });

  it("gives every prep-time band an ordinal, fastest first", () => {
    expect(prepTimeIndex("<20min")).toBe(0);
    expect(prepTimeIndex("20-40min")).toBe(1);
    expect(prepTimeIndex("40min+")).toBe(2);
  });

  it("covers every value of the locked enums", () => {
    for (const tier of CostTierSchema.options) expect(Number.isFinite(costTierIndex(tier))).toBe(true);
    for (const band of PrepTimeBandSchema.options) {
      expect(Number.isFinite(prepTimeIndex(band))).toBe(true);
    }
  });

  it("orders strictly, so one enum step is always a real score difference", () => {
    expect(CostTierSchema.options.map(costTierIndex)).toEqual([0, 1, 2]);
    expect(PrepTimeBandSchema.options.map(prepTimeIndex)).toEqual([0, 1, 2]);
  });

  it("gives every familiarity value an ordinal, most familiar first", () => {
    expect(familiarityIndex("everyday")).toBe(0);
    expect(familiarityIndex("occasional")).toBe(1);
    expect(familiarityIndex("adventurous")).toBe(2);
  });
});

describe("inSeasonFraction", () => {
  it("counts a year-round ingredient as in season in any month", () => {
    expect(inSeasonFraction(seasonalityData, neutralCandidate("t"), 3)).toBe(1);
  });

  it("counts a seasonal ingredient only within its peak months", () => {
    const c = candidate("t", {
      ingredient_slots: [{ role: "vegetable", ingredient_id: "sommar", substitutable: true }],
    });

    expect(inSeasonFraction(seasonalityData, c, 7)).toBe(1);
    expect(inSeasonFraction(seasonalityData, c, 1)).toBe(0);
  });

  it("returns the fraction of slots in season", () => {
    const c = candidate("t", {
      ingredient_slots: [
        { role: "vegetable", ingredient_id: "aret-runt", substitutable: true },
        { role: "vegetable", ingredient_id: "sommar", substitutable: true },
      ],
    });

    expect(inSeasonFraction(seasonalityData, c, 1)).toBe(0.5);
  });

  it("treats an ingredient absent from the catalog as out of season", () => {
    const c = candidate("t", {
      ingredient_slots: [{ role: "vegetable", ingredient_id: "finns-inte", substitutable: true }],
    });

    expect(inSeasonFraction(seasonalityData, c, 7)).toBe(0);
  });
});

describe("scoreCandidate", () => {
  it("adds one cost-tier step per unit of cost weight", () => {
    const premium = neutralCandidate("t", { cost_tier: "premium", prep_time_band: "<20min" });

    // 2 tiers * 1.5 weight, minus the full seasonality bonus of 0.25.
    expect(scoreCandidate(seasonalityData, premium, { cost: 1.5, time: 0 }, 1)).toBeCloseTo(2.75);
  });

  it("adds one prep-band step per unit of time weight", () => {
    const slow = neutralCandidate("t", { cost_tier: "budget", prep_time_band: "40min+" });

    expect(scoreCandidate(seasonalityData, slow, { cost: 0, time: 2 }, 1)).toBeCloseTo(3.75);
  });

  it("subtracts at most 0.25 for seasonality, less than a single enum step at weight 1", () => {
    const inSeason = neutralCandidate("t");
    const outOfSeason = candidate("t", {
      ingredient_slots: [{ role: "vegetable", ingredient_id: "sommar", substitutable: true }],
    });
    const weights = { cost: 1, time: 1 };

    const spread =
      scoreCandidate(seasonalityData, outOfSeason, weights, 1) -
      scoreCandidate(seasonalityData, inSeason, weights, 1);

    expect(spread).toBeCloseTo(0.25);
    expect(spread).toBeLessThan(1);
  });

  it("adds 1.5 per familiarity step, regardless of weights", () => {
    const everyday = neutralCandidate("t", { familiarity: "everyday" });
    const occasional = neutralCandidate("t", { familiarity: "occasional" });
    const adventurous = neutralCandidate("t", { familiarity: "adventurous" });
    const weights = { cost: 0, time: 0 };

    // neutralCandidate's slot is always in season, so each score also carries the
    // full -0.25 seasonality bonus.
    expect(scoreCandidate(seasonalityData, everyday, weights, 1)).toBeCloseTo(-0.25);
    expect(scoreCandidate(seasonalityData, occasional, weights, 1)).toBeCloseTo(1.25);
    expect(scoreCandidate(seasonalityData, adventurous, weights, 1)).toBeCloseTo(2.75);
  });
});

describe("scoreCandidate — omnivore preference", () => {
  const weights = { cost: 0, time: 0 };

  it("adds one familiarity step's worth of penalty to a vegetarian template for a household with no dietary flags", () => {
    const meat = neutralCandidate("t", { dietary_tags: [] });
    const veg = neutralCandidate("t", { dietary_tags: ["vegetarian"] });

    const spread = scoreCandidate(seasonalityData, veg, weights, 1, []) -
      scoreCandidate(seasonalityData, meat, weights, 1, []);

    expect(spread).toBeCloseTo(1.5);
  });

  it("applies the same penalty to a vegan template", () => {
    const meat = neutralCandidate("t", { dietary_tags: [] });
    const vegan = neutralCandidate("t", { dietary_tags: ["vegan"] });

    const spread = scoreCandidate(seasonalityData, vegan, weights, 1, []) -
      scoreCandidate(seasonalityData, meat, weights, 1, []);

    expect(spread).toBeCloseTo(1.5);
  });

  it("applies no penalty when the household declared vegetarian", () => {
    const veg = neutralCandidate("t", { dietary_tags: ["vegetarian"] });

    expect(scoreCandidate(seasonalityData, veg, weights, 1, ["vegetarian"])).toBeCloseTo(
      scoreCandidate(seasonalityData, veg, weights, 1, []) - 1.5,
    );
  });

  it("applies no penalty when the household declared vegan", () => {
    const vegan = neutralCandidate("t", { dietary_tags: ["vegan"] });

    expect(scoreCandidate(seasonalityData, vegan, weights, 1, ["vegan"])).toBeCloseTo(
      scoreCandidate(seasonalityData, vegan, weights, 1, []) - 1.5,
    );
  });

  it("defaults to no declared dietary flags when the parameter is omitted", () => {
    const veg = neutralCandidate("t", { dietary_tags: ["vegetarian"] });

    expect(scoreCandidate(seasonalityData, veg, weights, 1)).toBeCloseTo(
      scoreCandidate(seasonalityData, veg, weights, 1, []),
    );
  });

  it("never filters a vegetarian template out of rankCandidates for an omnivore household", () => {
    const veg = neutralCandidate("only-veg", { dietary_tags: ["vegetarian"] });

    const ranked = rankCandidates(seasonalityData, [veg], weights, 1, []);

    expect(ids(ranked)).toEqual(["only-veg"]);
  });
});

describe("rankCandidates — weight response", () => {
  const cheapSlow = neutralCandidate("cheap-slow", { cost_tier: "budget", prep_time_band: "40min+" });
  const pricyFast = neutralCandidate("pricy-fast", { cost_tier: "premium", prep_time_band: "<20min" });
  const candidates = [cheapSlow, pricyFast];

  it("puts the cheaper template first as cost weight rises, time held fixed", () => {
    expect(ids(rankCandidates(seasonalityData, candidates, { cost: 0, time: 1 }, 1))).toEqual([
      "pricy-fast",
      "cheap-slow",
    ]);

    expect(ids(rankCandidates(seasonalityData, candidates, { cost: 3, time: 1 }, 1))).toEqual([
      "cheap-slow",
      "pricy-fast",
    ]);
  });

  it("puts the faster template first as time weight rises, cost held fixed", () => {
    expect(ids(rankCandidates(seasonalityData, candidates, { cost: 1, time: 0 }, 1))).toEqual([
      "cheap-slow",
      "pricy-fast",
    ]);

    expect(ids(rankCandidates(seasonalityData, candidates, { cost: 1, time: 3 }, 1))).toEqual([
      "pricy-fast",
      "cheap-slow",
    ]);
  });

  it("does not mutate the input array or its candidates", () => {
    const input = [pricyFast, cheapSlow];
    const snapshot = structuredClone(input);

    rankCandidates(seasonalityData, input, { cost: 2, time: 1 }, 1);

    expect(input).toEqual(snapshot);
    expect(input[0]).toBe(pricyFast);
  });
});

describe("rankCandidates — tie-break", () => {
  it("breaks ties on template id, deterministically across repeated calls", () => {
    // Identical on cost, time and seasonality — only the id differs.
    const candidates = [
      neutralCandidate("zucchinipasta"),
      neutralCandidate("agggratang"),
      neutralCandidate("morotssoppa"),
    ];
    const weights = { cost: 1, time: 1 };

    const first = ids(rankCandidates(seasonalityData, candidates, weights, 1));

    expect(first).toEqual(["agggratang", "morotssoppa", "zucchinipasta"]);
    for (let run = 0; run < 5; run += 1) {
      expect(ids(rankCandidates(seasonalityData, candidates, weights, 1))).toEqual(first);
    }
  });

  it("keeps the tie-break stable regardless of input order", () => {
    const a = neutralCandidate("a-ratt");
    const b = neutralCandidate("b-ratt");

    expect(ids(rankCandidates(seasonalityData, [a, b], { cost: 1, time: 1 }, 1))).toEqual([
      "a-ratt",
      "b-ratt",
    ]);
    expect(ids(rankCandidates(seasonalityData, [b, a], { cost: 1, time: 1 }, 1))).toEqual([
      "a-ratt",
      "b-ratt",
    ]);
  });
});

describe("rankCandidates — familiarity", () => {
  it("puts the more familiar template first when everything else is equal", () => {
    const everyday = neutralCandidate("everyday-dish", { familiarity: "everyday" });
    const adventurous = neutralCandidate("adventurous-dish", { familiarity: "adventurous" });

    expect(ids(rankCandidates(seasonalityData, [adventurous, everyday], { cost: 1, time: 1 }, 1))).toEqual([
      "everyday-dish",
      "adventurous-dish",
    ]);
  });

  it("outranks a full seasonality swing with a single familiarity step", () => {
    // "occasional-in-season" beats seasonality's max 0.25 bonus on its own,
    // so scoring purely on familiarity vs. seasonality still favors familiarity.
    const everydayOutOfSeason = candidate("everyday-out-of-season", {
      familiarity: "everyday",
      ingredient_slots: [{ role: "vegetable", ingredient_id: "sommar", substitutable: true }],
    });
    const occasionalInSeason = candidate("occasional-in-season", {
      familiarity: "occasional",
      ingredient_slots: [{ role: "vegetable", ingredient_id: "aret-runt", substitutable: true }],
    });

    expect(
      ids(rankCandidates(seasonalityData, [occasionalInSeason, everydayOutOfSeason], { cost: 0, time: 0 }, 1)),
    ).toEqual(["everyday-out-of-season", "occasional-in-season"]);
  });

  it("lets a strong enough expressed cost preference beat a familiarity gap", () => {
    const everydayExpensive = neutralCandidate("everyday-expensive", {
      familiarity: "everyday",
      cost_tier: "premium",
    });
    const adventurousCheap = neutralCandidate("adventurous-cheap", {
      familiarity: "adventurous",
      cost_tier: "budget",
    });
    const weights = { cost: 3, time: 0 };

    // 2 cost-tier steps * weight 3 = 6, which beats the 3.0 two-step familiarity gap.
    expect(ids(rankCandidates(seasonalityData, [everydayExpensive, adventurousCheap], weights, 1))).toEqual([
      "adventurous-cheap",
      "everyday-expensive",
    ]);
  });

  it("ranks an everyday premium template above an adventurous budget one at default weights", () => {
    // The concrete regression this slice fixes: at the API's default {cost: 1,
    // time: 1} (src/api/weights.ts), a cheap unusual dish must not beat an
    // ordinary one just because it happens to be cheaper.
    const everydayPremium = neutralCandidate("everyday-premium", {
      familiarity: "everyday",
      cost_tier: "premium",
    });
    const adventurousBudget = neutralCandidate("adventurous-budget", {
      familiarity: "adventurous",
      cost_tier: "budget",
    });
    const defaultWeights = { cost: 1, time: 1 };

    expect(
      ids(rankCandidates(seasonalityData, [adventurousBudget, everydayPremium], defaultWeights, 1)),
    ).toEqual(["everyday-premium", "adventurous-budget"]);
  });

  it("still returns an adventurous template when it is the only candidate", () => {
    const onlyOption = neutralCandidate("only-adventurous", { familiarity: "adventurous" });

    const tonight = pickTonight(seasonalityData, [onlyOption], { cost: 1, time: 1 }, 1);

    expect(tonight?.template.id).toBe("only-adventurous");
  });
});

describe("rankCandidates — substitution seasonality", () => {
  it("scores a rescued slot on the substitute, not the excluded original", () => {
    // "b-rescued" holds an out-of-season ingredient in January, rescued with a
    // year-round substitute. Its id deliberately sorts *after* the comparison
    // template: scoring the original would leave the two tied at 0 and hand first
    // place to "a-baseline" on the id tie-break, so this ordering can only come from
    // scoring the substitute.
    const rescued = candidate(
      "b-rescued",
      {
        ingredient_slots: [{ role: "vegetable", ingredient_id: "sommar", substitutable: true }],
      },
      [
        {
          slot_index: 0,
          slot: { role: "vegetable", ingredient_id: "sommar", substitutable: true },
          substitute_ingredient_id: "aret-runt",
        },
      ],
    );
    const baseline = candidate("a-baseline", {
      ingredient_slots: [{ role: "vegetable", ingredient_id: "sommar", substitutable: true }],
    });

    const ranked = rankCandidates(seasonalityData, [baseline, rescued], { cost: 0, time: 0 }, 1);

    expect(ids(ranked)).toEqual(["b-rescued", "a-baseline"]);
    expect(ranked[0]!.score).toBeCloseTo(-0.25);
    expect(ranked[1]!.score).toBe(0);
  });

  it("scores unrescued slots on their own ingredient", () => {
    const mixed = candidate(
      "t",
      {
        ingredient_slots: [
          { role: "vegetable", ingredient_id: "sommar", substitutable: true },
          { role: "vegetable", ingredient_id: "sommar", substitutable: true },
        ],
      },
      [
        {
          slot_index: 1,
          slot: { role: "vegetable", ingredient_id: "sommar", substitutable: true },
          substitute_ingredient_id: "aret-runt",
        },
      ],
    );

    expect(inSeasonFraction(seasonalityData, mixed, 1)).toBe(0.5);
  });
});

describe("rankCandidates — zero weights", () => {
  it("orders by seasonality alone when the household has expressed no preference", () => {
    const allInSeason = candidate("premium-slow-in-season", {
      // Most expensive and slowest, yet still first: with both weights at zero,
      // nothing but seasonality can order the set.
      cost_tier: "premium",
      prep_time_band: "40min+",
      ingredient_slots: [{ role: "vegetable", ingredient_id: "vinter", substitutable: true }],
    });
    const halfInSeason = candidate("budget-fast-half-season", {
      cost_tier: "budget",
      prep_time_band: "<20min",
      ingredient_slots: [
        { role: "vegetable", ingredient_id: "vinter", substitutable: true },
        { role: "vegetable", ingredient_id: "sommar", substitutable: true },
      ],
    });
    const noneInSeason = candidate("budget-fast-out-of-season", {
      cost_tier: "budget",
      prep_time_band: "<20min",
      ingredient_slots: [{ role: "vegetable", ingredient_id: "sommar", substitutable: true }],
    });

    const ranked = rankCandidates(
      seasonalityData,
      [noneInSeason, halfInSeason, allInSeason],
      { cost: 0, time: 0 },
      1,
    );

    expect(ids(ranked)).toEqual([
      "premium-slow-in-season",
      "budget-fast-half-season",
      "budget-fast-out-of-season",
    ]);
    expect(ranked.map((r) => r.score)).toEqual([-0.25, -0.125, 0]);
  });
});

describe("pickTonight", () => {
  it("returns undefined for an empty candidate set rather than throwing", () => {
    expect(pickTonight(seasonalityData, [], { cost: 1, time: 1 }, 1)).toBeUndefined();
  });

  it("returns the single candidate when there is only one", () => {
    const only = neutralCandidate("enda-ratten");

    expect(pickTonight(seasonalityData, [only], { cost: 1, time: 1 }, 1)?.template.id).toBe(
      "enda-ratten",
    );
  });

  it("always equals rankCandidates()[0] for the same inputs", () => {
    const candidates = [
      neutralCandidate("a", { cost_tier: "premium", prep_time_band: "<20min" }),
      neutralCandidate("b", { cost_tier: "budget", prep_time_band: "40min+" }),
      candidate("c", {
        cost_tier: "mid",
        prep_time_band: "20-40min",
        ingredient_slots: [{ role: "vegetable", ingredient_id: "sommar", substitutable: true }],
      }),
      candidate("d", {
        cost_tier: "mid",
        prep_time_band: "20-40min",
        ingredient_slots: [{ role: "vegetable", ingredient_id: "vinter", substitutable: true }],
      }),
    ];

    const weightCombos: RankingWeights[] = [
      { cost: 0, time: 0 },
      { cost: 1, time: 0 },
      { cost: 0, time: 1 },
      { cost: 1, time: 1 },
      { cost: 3, time: 0.5 },
      { cost: 0.5, time: 3 },
      { cost: 0.1, time: 0.1 },
    ];

    for (const weights of weightCombos) {
      for (const month of [1, 4, 7, 12]) {
        const ranked = rankCandidates(seasonalityData, candidates, weights, month);

        expect(pickTonight(seasonalityData, candidates, weights, month)).toEqual(ranked[0]);
      }
    }
  });
});

describe("pickNextSuggestion", () => {
  const weights = { cost: 1, time: 1 };

  it("never returns an excluded template id", () => {
    const candidates = [neutralCandidate("a"), neutralCandidate("b"), neutralCandidate("c")];
    const ranked = rankCandidates(seasonalityData, candidates, weights, 1);

    const picked = pickNextSuggestion(ranked, new Set(["agggratang", "a", "b"]), undefined);

    expect(picked?.template.id).toBe("c");
  });

  it("prefers a different protein_group over a better-scoring same-protein_group candidate", () => {
    const previous = makeTemplate("previous", { protein_group: "beef_pork", cuisine: "swedish_nordic" });
    const sameProteinBetter = neutralCandidate("same-protein-better", {
      protein_group: "beef_pork",
      cuisine: "italian_mediterranean",
      cost_tier: "budget",
    });
    const differentProteinWorse = neutralCandidate("different-protein-worse", {
      protein_group: "fish_seafood",
      cuisine: "italian_mediterranean",
      cost_tier: "premium",
    });
    const ranked = rankCandidates(
      seasonalityData,
      [sameProteinBetter, differentProteinWorse],
      weights,
      1,
    );

    expect(ranked[0]!.template.id).toBe("same-protein-better");

    const picked = pickNextSuggestion(ranked, new Set(), previous);

    expect(picked?.template.id).toBe("different-protein-worse");
  });

  it("uses cuisine as the secondary preference among different-protein candidates", () => {
    const previous = makeTemplate("previous", { protein_group: "beef_pork", cuisine: "swedish_nordic" });
    const differentProteinSameCuisine = neutralCandidate("different-protein-same-cuisine", {
      protein_group: "fish_seafood",
      cuisine: "swedish_nordic",
      cost_tier: "budget",
    });
    const differentProteinAndCuisine = neutralCandidate("different-protein-and-cuisine", {
      protein_group: "chicken_poultry",
      cuisine: "asian",
      cost_tier: "premium",
    });
    const ranked = rankCandidates(
      seasonalityData,
      [differentProteinSameCuisine, differentProteinAndCuisine],
      weights,
      1,
    );

    expect(ranked[0]!.template.id).toBe("different-protein-same-cuisine");

    const picked = pickNextSuggestion(ranked, new Set(), previous);

    expect(picked?.template.id).toBe("different-protein-and-cuisine");
  });

  it("falls back to the best-scoring remaining candidate when no diverse option exists", () => {
    const previous = makeTemplate("previous", { protein_group: "beef_pork", cuisine: "swedish_nordic" });
    const best = neutralCandidate("best", {
      protein_group: "beef_pork",
      cuisine: "swedish_nordic",
      cost_tier: "budget",
    });
    const worst = neutralCandidate("worst", {
      protein_group: "beef_pork",
      cuisine: "swedish_nordic",
      cost_tier: "premium",
    });
    const ranked = rankCandidates(seasonalityData, [best, worst], weights, 1);

    const picked = pickNextSuggestion(ranked, new Set(), previous);

    expect(picked?.template.id).toBe("best");
  });

  it("returns undefined when every candidate is excluded", () => {
    const candidates = [neutralCandidate("a"), neutralCandidate("b")];
    const ranked = rankCandidates(seasonalityData, candidates, weights, 1);

    expect(pickNextSuggestion(ranked, new Set(["a", "b"]), undefined)).toBeUndefined();
  });

  it("is deterministic across repeated calls with identical inputs", () => {
    const previous = makeTemplate("previous", { protein_group: "beef_pork", cuisine: "swedish_nordic" });
    const candidates = [
      neutralCandidate("a", { protein_group: "fish_seafood" }),
      neutralCandidate("b", { protein_group: "chicken_poultry" }),
      neutralCandidate("c", { protein_group: "beef_pork" }),
    ];
    const ranked = rankCandidates(seasonalityData, candidates, weights, 1);

    const first = pickNextSuggestion(ranked, new Set(["a"]), previous)?.template.id;
    for (let run = 0; run < 5; run += 1) {
      expect(pickNextSuggestion(ranked, new Set(["a"]), previous)?.template.id).toBe(first);
    }
  });
});

// --- Real-data assertions ------------------------------------------------------

const data = await loadEngineData();
const noRestrictions = makeConstraints();

describe("rankCandidates — over the real candidate set", () => {
  const candidates = selectCandidateTemplates(data, noRestrictions);

  it("ranks every candidate exactly once, in non-decreasing score order", () => {
    const ranked = rankCandidates(data, candidates, { cost: 1, time: 1 }, 8);

    // 148, not 170: the meal_types hard filter (#68) now excludes the 22
    // templates without "dinner" in meal_types (14 breakfast/lunch-only, plus
    // pannkakor-med-vaniljsocker and artsoppa-med-senap corrected off dinner,
    // plus the six-template dinner-bar tightening — see DECISION_LOG) from the
    // dinner-facing candidate set.
    expect(ranked).toHaveLength(148);
    expect(new Set(ranked.map((r) => r.template.id)).size).toBe(148);
    for (let i = 1; i < ranked.length; i += 1) {
      expect(ranked[i]!.score).toBeGreaterThanOrEqual(ranked[i - 1]!.score);
    }
  });

  it("gives Tonight a budget, fast meal when the household asks for cheap and quick", () => {
    const tonight = pickTonight(data, candidates, { cost: 3, time: 3 }, 8);

    expect(tonight?.template.cost_tier).toBe("budget");
    expect(tonight?.template.prep_time_band).toBe("<20min");
  });

  it("picks the same Tonight across repeated runs for the same inputs", () => {
    const first = pickTonight(data, candidates, { cost: 1, time: 1 }, 8)?.template.id;

    for (let run = 0; run < 3; run += 1) {
      expect(pickTonight(data, candidates, { cost: 1, time: 1 }, 8)?.template.id).toBe(first);
    }
  });

  it("responds to the month — some template's score changes between January and July", () => {
    const january = rankCandidates(data, candidates, { cost: 1, time: 1 }, 1);
    const july = rankCandidates(data, candidates, { cost: 1, time: 1 }, 7);

    const scoreById = new Map(january.map((r) => [r.template.id, r.score]));
    const changed = july.filter((r) => scoreById.get(r.template.id) !== r.score);

    expect(changed.length).toBeGreaterThan(0);
  });
});

describe("rankCandidates — real catalog seasonality (#50)", () => {
  it("ranks a template above an otherwise equivalent one in its own peak month, and does not in the other's peak month", () => {
    // sparris (asparagus) peaks strictly in May-June; pumpa (pumpkin) peaks
    // Sept-Nov (data/ingredients.json) — disjoint real peak windows. Both
    // templates are identical apart from that one slot, so seasonality is
    // the only thing that can move the order at zero cost/time weight.
    const sparrisCandidate = candidate("uses-sparris", {
      cost_tier: "mid",
      prep_time_band: "20-40min",
      ingredient_slots: [{ role: "vegetable", ingredient_id: "sparris", substitutable: true }],
    });
    const pumpaCandidate = candidate("uses-pumpa", {
      cost_tier: "mid",
      prep_time_band: "20-40min",
      ingredient_slots: [{ role: "vegetable", ingredient_id: "pumpa", substitutable: true }],
    });

    const may = rankCandidates(data, [pumpaCandidate, sparrisCandidate], { cost: 0, time: 0 }, 5);
    expect(ids(may)).toEqual(["uses-sparris", "uses-pumpa"]);

    const september = rankCandidates(
      data,
      [pumpaCandidate, sparrisCandidate],
      { cost: 0, time: 0 },
      9,
    );
    expect(ids(september)).toEqual(["uses-pumpa", "uses-sparris"]);
  });
});

// Repeat-avoidance (#88) -------------------------------------------------------
//
// A fixed `now` throughout: `RecencyContext` carries the instant as data precisely so
// these tests need no clock mocking and no tolerance for a test running across midnight.

const NOW = new Date("2026-08-05T18:00:00Z");

function daysAgo(days: number, hours = 0): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000 - hours * 60 * 60 * 1000);
}

function recency(entries: Record<string, Date>): RecencyContext {
  return { history: new Map(Object.entries(entries)), now: NOW };
}

describe("buildCookingHistory", () => {
  it("keeps only the most recent cooking of each template, whatever order rows arrive in", () => {
    const history = buildCookingHistory([
      { template_id: "a", cooked_at: daysAgo(3) },
      { template_id: "b", cooked_at: daysAgo(1) },
      { template_id: "a", cooked_at: daysAgo(10) },
    ]);

    expect(history.get("a")).toEqual(daysAgo(3));
    expect(history.get("b")).toEqual(daysAgo(1));
    expect(history.size).toBe(2);
  });

  it("is empty for a household with no history, rather than undefined", () => {
    expect(buildCookingHistory([]).size).toBe(0);
  });
});

describe("recencyPenalty", () => {
  it("is the full weight for a meal cooked today", () => {
    expect(recencyPenalty("a", recency({ a: daysAgo(0) }))).toBeCloseTo(5.0);
  });

  it("decays linearly across the window", () => {
    // 5.0 * (1 - d/14): half the weight at day 7, one 14th of it left on day 13.
    expect(recencyPenalty("a", recency({ a: daysAgo(7) }))).toBeCloseTo(2.5);
    expect(recencyPenalty("a", recency({ a: daysAgo(13) }))).toBeCloseTo(5.0 / 14);
  });

  it("is exactly zero at the window edge and beyond — no residue", () => {
    expect(recencyPenalty("a", recency({ a: daysAgo(14) }))).toBe(0);
    expect(recencyPenalty("a", recency({ a: daysAgo(40) }))).toBe(0);
  });

  it("is quantised to whole days, so a score does not drift hour by hour", () => {
    const morning = recencyPenalty("a", recency({ a: daysAgo(3, 1) }));
    const evening = recencyPenalty("a", recency({ a: daysAgo(3, 20) }));

    expect(morning).toBe(evening);
  });

  it("is zero for a template with no history at all", () => {
    expect(recencyPenalty("never-cooked", recency({ a: daysAgo(1) }))).toBe(0);
  });

  it("treats a future timestamp as just cooked rather than turning the penalty into a bonus", () => {
    // Clock skew between the database and this process must not be able to *promote* a
    // dish the household just cooked.
    const future = new Date(NOW.getTime() + 60 * 60 * 1000);

    expect(recencyPenalty("a", recency({ a: future }))).toBeCloseTo(5.0);
  });
});

describe("rankCandidates — repeat avoidance", () => {
  const zero = { cost: 0, time: 0 };

  it("ranks a recently cooked template below an otherwise identical uncooked one", () => {
    const cooked = neutralCandidate("a-cooked");
    const fresh = neutralCandidate("b-fresh");

    // Note the ids: without recency the id tie-break would put "a-cooked" first, so a
    // pass here cannot come from lexical ordering.
    const ranked = rankCandidates(seasonalityData, [cooked, fresh], zero, 1, [], recency({
      "a-cooked": daysAgo(0),
    }));

    expect(ids(ranked)).toEqual(["b-fresh", "a-cooked"]);
  });

  it("orders several cooked templates by how long ago, least recent first", () => {
    const candidates = [
      neutralCandidate("yesterday"),
      neutralCandidate("last-week"),
      neutralCandidate("never"),
    ];

    const ranked = rankCandidates(seasonalityData, candidates, zero, 1, [], recency({
      yesterday: daysAgo(1),
      "last-week": daysAgo(7),
    }));

    expect(ids(ranked)).toEqual(["never", "last-week", "yesterday"]);
  });

  it("stops penalising once the template leaves the window", () => {
    const stale = neutralCandidate("a-stale");
    const fresh = neutralCandidate("b-fresh");

    const ranked = rankCandidates(seasonalityData, [stale, fresh], zero, 1, [], recency({
      "a-stale": daysAgo(14),
    }));

    // Scores are equal again — the penalty really is gone, not merely small. Ordering
    // then falls to the least-recently-cooked tie-break, which still prefers the
    // never-cooked dish; that is a free choice between equals, not a penalty.
    expect(ranked.map((r) => r.score)).toEqual([ranked[0]!.score, ranked[0]!.score]);
    expect(ids(ranked)).toEqual(["b-fresh", "a-stale"]);
  });

  it("beats the largest non-recency spread available at default weights (the 4.75 lower bound)", () => {
    // The worst possible uncooked candidate — adventurous *and* vegetarian for an
    // omnivore household, 3.0 + 1.5 = 4.5 of penalty — must still outrank a dish cooked
    // tonight. This is the bound RECENCY_PENALTY_WEIGHT is derived against; drop the
    // weight below 4.75 and this test fails.
    const cookedTonight = neutralCandidate("a-cooked-tonight", {
      familiarity: "everyday",
      dietary_tags: [],
    });
    const worstFresh = neutralCandidate("b-adventurous-veg", {
      familiarity: "adventurous",
      dietary_tags: ["vegetarian"],
    });

    const ranked = rankCandidates(
      seasonalityData,
      [cookedTonight, worstFresh],
      zero,
      1,
      [],
      recency({ "a-cooked-tonight": daysAgo(0) }),
    );

    expect(ids(ranked)).toEqual(["b-adventurous-veg", "a-cooked-tonight"]);
  });

  it("still yields to a maxed adjustment chip across two enum steps (the 6.0 upper bound)", () => {
    // A household that taps "Billigare" to level 2 (weight 3) and means it can still be
    // shown last night's budget dish ahead of an untried premium one: 2 * 3 = 6.0 of
    // cost penalty beats the 5.0 recency penalty. Repeat-avoidance is strong, not absolute.
    const cookedBudget = neutralCandidate("cooked-budget", { cost_tier: "budget" });
    const freshPremium = neutralCandidate("fresh-premium", { cost_tier: "premium" });

    const ranked = rankCandidates(
      seasonalityData,
      [cookedBudget, freshPremium],
      { cost: 3, time: 0 },
      1,
      [],
      recency({ "cooked-budget": daysAgo(0) }),
    );

    expect(ids(ranked)).toEqual(["cooked-budget", "fresh-premium"]);
  });

  it("penalises rather than filters — a household that cooked everything still gets a full set", () => {
    const candidates = [
      neutralCandidate("alpha"),
      neutralCandidate("beta"),
      neutralCandidate("gamma"),
    ];

    const ranked = rankCandidates(seasonalityData, candidates, zero, 1, [], recency({
      alpha: daysAgo(0),
      beta: daysAgo(0),
      gamma: daysAgo(0),
    }));

    expect(ids(ranked)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("scores identically to a call with no history when the recency argument is omitted", () => {
    const candidates = [neutralCandidate("a"), neutralCandidate("b")];

    const without = rankCandidates(seasonalityData, candidates, zero, 1, []);
    const emptyHistory = rankCandidates(seasonalityData, candidates, zero, 1, [], recency({}));

    expect(emptyHistory.map((r) => r.score)).toEqual(without.map((r) => r.score));
    expect(ids(emptyHistory)).toEqual(ids(without));
  });
});

describe("rankCandidates — recency tie-break", () => {
  const zero = { cost: 0, time: 0 };

  it("prefers the least recently cooked of two dishes cooked on the same day", () => {
    // Same day means an identical (day-quantised) penalty, so scores tie and the
    // tie-break is the only thing separating them.
    const early = neutralCandidate("b-early-yesterday");
    const late = neutralCandidate("a-late-yesterday");

    const ranked = rankCandidates(seasonalityData, [late, early], zero, 1, [], recency({
      "a-late-yesterday": daysAgo(1, 1),
      "b-early-yesterday": daysAgo(1, 20),
    }));

    // Ids would order these the other way round; recency wins.
    expect(ids(ranked)).toEqual(["b-early-yesterday", "a-late-yesterday"]);
  });

  it("prefers a never-cooked template over one whose penalty has fully decayed", () => {
    const stale = neutralCandidate("a-stale");
    const never = neutralCandidate("b-never");

    const ranked = rankCandidates(seasonalityData, [stale, never], zero, 1, [], recency({
      "a-stale": daysAgo(60),
    }));

    expect(ids(ranked)).toEqual(["b-never", "a-stale"]);
  });

  it("falls back to the template id when neither candidate was ever cooked", () => {
    const ranked = rankCandidates(
      seasonalityData,
      [neutralCandidate("zucchinipasta"), neutralCandidate("agggratang")],
      zero,
      1,
      [],
      recency({ something: daysAgo(2) }),
    );

    expect(ids(ranked)).toEqual(["agggratang", "zucchinipasta"]);
  });

  it("picks the same order across repeated runs, so Tonight never flip-flops", () => {
    const candidates = [
      neutralCandidate("alpha"),
      neutralCandidate("beta"),
      neutralCandidate("gamma"),
    ];
    const history = recency({ alpha: daysAgo(1), beta: daysAgo(1) });

    const first = ids(rankCandidates(seasonalityData, candidates, zero, 1, [], history));

    for (let run = 0; run < 5; run += 1) {
      expect(ids(rankCandidates(seasonalityData, candidates, zero, 1, [], history))).toEqual(first);
    }
  });
});

describe("pickTonight — repeat avoidance", () => {
  const zero = { cost: 0, time: 0 };

  it("suggests a different dish the evening after one was cooked", () => {
    const candidates = [neutralCandidate("a-kottbullar"), neutralCandidate("b-fisksoppa")];

    const first = pickTonight(seasonalityData, candidates, zero, 1);
    expect(first?.template.id).toBe("a-kottbullar");

    const second = pickTonight(seasonalityData, candidates, zero, 1, [], recency({
      "a-kottbullar": daysAgo(0),
    }));
    expect(second?.template.id).toBe("b-fisksoppa");
  });

  it("still returns a suggestion when every candidate was cooked today", () => {
    // The failure mode a hard filter would produce: an empty Tonight for a household
    // whose candidate set is small (UX_FLOW §9 — never dead-end the user).
    const candidates = [neutralCandidate("alpha"), neutralCandidate("beta")];

    const picked = pickTonight(seasonalityData, candidates, zero, 1, [], recency({
      alpha: daysAgo(0),
      beta: daysAgo(0),
    }));

    expect(picked).toBeDefined();
    expect(picked?.template.id).toBe("alpha");
  });

  it("still returns a suggestion for a single-candidate household that just cooked it", () => {
    const only = neutralCandidate("enda-ratten");

    const picked = pickTonight(seasonalityData, [only], zero, 1, [], recency({
      "enda-ratten": daysAgo(0),
    }));

    expect(picked?.template.id).toBe("enda-ratten");
  });

  it("rotates through the real candidate set instead of repeating one dish three nights running", () => {
    const candidates = selectCandidateTemplates(data, noRestrictions);
    const history = new Map<string, Date>();
    const picks: string[] = [];

    for (let evening = 0; evening < 3; evening += 1) {
      const picked = pickTonight(data, candidates, zero, 8, [], { history, now: NOW });
      expect(picked).toBeDefined();
      picks.push(picked!.template.id);
      // The household cooks what it was shown, that same evening.
      history.set(picked!.template.id, NOW);
    }

    expect(new Set(picks).size).toBe(3);
  });
});

// #122: "why this dish". Each test builds a two-candidate ranked list where every
// score term is held equal except the one under test, so a pass can only come from
// that term actually being what separates the winner from the runner-up — never
// from a coincidence in the fixture defaults.
describe("explainSuggestion", () => {
  const zero = { cost: 0, time: 0 };

  it("credits seasonality when it is the only thing separating the winner from the runner-up", () => {
    const winner = candidate("in-season", {
      ingredient_slots: [{ role: "vegetable", ingredient_id: "aret-runt", substitutable: true }],
    });
    const runnerUp = candidate("out-of-season", {
      ingredient_slots: [{ role: "vegetable", ingredient_id: "vinter", substitutable: true }],
    });

    const ranked = rankCandidates(seasonalityData, [winner, runnerUp], zero, 7);
    const picked = ranked.find((c) => c.template.id === "in-season")!;

    expect(
      explainSuggestion(seasonalityData, ranked, new Set(), picked, undefined, zero, 7),
    ).toEqual(["in_season"]);
  });

  it("credits repeat-avoidance when the runner-up was cooked recently and the winner was not", () => {
    const winner = neutralCandidate("never-cooked");
    const runnerUp = neutralCandidate("cooked-today");
    const context = recency({ "cooked-today": daysAgo(0) });

    const ranked = rankCandidates(seasonalityData, [winner, runnerUp], zero, 1, [], context);
    const picked = ranked.find((c) => c.template.id === "never-cooked")!;

    expect(
      explainSuggestion(seasonalityData, ranked, new Set(), picked, undefined, zero, 1, [], context),
    ).toEqual(["not_recently_cooked"]);
  });

  it("credits the cost preference only when a cost weight is actually in play", () => {
    const winner = neutralCandidate("budget-pick", { cost_tier: "budget" });
    const runnerUp = neutralCandidate("mid-pick", { cost_tier: "mid" });
    const weights = { cost: 1, time: 0 };

    const ranked = rankCandidates(seasonalityData, [winner, runnerUp], weights, 1);
    const picked = ranked.find((c) => c.template.id === "budget-pick")!;

    expect(explainSuggestion(seasonalityData, ranked, new Set(), picked, undefined, weights, 1)).toEqual([
      "cost_preference",
    ]);
  });

  it("credits the time preference only when a time weight is actually in play", () => {
    const winner = neutralCandidate("fast-pick", { prep_time_band: "<20min" });
    const runnerUp = neutralCandidate("slow-pick", { prep_time_band: "40min+" });
    const weights = { cost: 0, time: 1 };

    const ranked = rankCandidates(seasonalityData, [winner, runnerUp], weights, 1);
    const picked = ranked.find((c) => c.template.id === "fast-pick")!;

    expect(explainSuggestion(seasonalityData, ranked, new Set(), picked, undefined, weights, 1)).toEqual([
      "time_preference",
    ]);
  });

  it("credits variety when the pick's protein group differs from last time's, tied score otherwise", () => {
    const winner = neutralCandidate("winner", { protein_group: "chicken_poultry" });
    const runnerUp = neutralCandidate("runner-up", { protein_group: "chicken_poultry" });
    const previous = makeTemplate("previous", { protein_group: "beef_pork" });

    const ranked = rankCandidates(seasonalityData, [winner, runnerUp], zero, 1);
    const picked = ranked.find((c) => c.template.id === "winner")!;

    expect(explainSuggestion(seasonalityData, ranked, new Set(), picked, previous, zero, 1)).toEqual([
      "different_from_last_time",
    ]);
  });

  it("is silent when the two candidates are indistinguishable on every term", () => {
    const winner = neutralCandidate("a");
    const runnerUp = neutralCandidate("b");

    const ranked = rankCandidates(seasonalityData, [winner, runnerUp], zero, 1);
    const picked = ranked[0]!;

    expect(explainSuggestion(seasonalityData, ranked, new Set(), picked, undefined, zero, 1)).toEqual([]);
  });

  it("stays silent rather than crediting a nameable term when familiarity was actually what won it", () => {
    // Nothing nameable differs — cost/time weights are zero, seasonality is tied,
    // there is no history — so if familiarity alone decided the order, requirement 5
    // says say nothing rather than credit seasonality or recency for a gap they did
    // not create.
    const winner = neutralCandidate("everyday-pick", { familiarity: "everyday" });
    const runnerUp = neutralCandidate("adventurous-pick", { familiarity: "adventurous" });

    const ranked = rankCandidates(seasonalityData, [winner, runnerUp], zero, 1);
    const picked = ranked.find((c) => c.template.id === "everyday-pick")!;

    expect(explainSuggestion(seasonalityData, ranked, new Set(), picked, undefined, zero, 1)).toEqual([]);
  });

  it("names at most two reasons, the two largest gaps, when three terms would otherwise qualify", () => {
    const winner = neutralCandidate("winner", { cost_tier: "budget", prep_time_band: "<20min" });
    const runnerUp = candidate("runner-up", {
      cost_tier: "premium",
      prep_time_band: "40min+",
      ingredient_slots: [{ role: "vegetable", ingredient_id: "vinter", substitutable: true }],
    });
    const weights = { cost: 1.5, time: 2 };

    const ranked = rankCandidates(seasonalityData, [winner, runnerUp], weights, 7);
    const picked = ranked.find((c) => c.template.id === "winner")!;

    // time gap (2 index steps * weight 2 = 4) > cost gap (2 * 1.5 = 3) > seasonality
    // gap (0.25) — the two largest, not the seasonality gap that also qualifies.
    expect(explainSuggestion(seasonalityData, ranked, new Set(), picked, undefined, weights, 7)).toEqual([
      "time_preference",
      "cost_preference",
    ]);
  });

  it("puts variety first and still caps at two when a score term also qualifies", () => {
    const winner = neutralCandidate("winner", { protein_group: "chicken_poultry" });
    const runnerUp = candidate("runner-up", {
      protein_group: "beef_pork",
      ingredient_slots: [{ role: "vegetable", ingredient_id: "vinter", substitutable: true }],
    });
    const previous = makeTemplate("previous", { protein_group: "beef_pork" });

    const ranked = rankCandidates(seasonalityData, [winner, runnerUp], zero, 7);
    const picked = ranked.find((c) => c.template.id === "winner")!;

    expect(explainSuggestion(seasonalityData, ranked, new Set(), picked, previous, zero, 7)).toEqual([
      "different_from_last_time",
      "in_season",
    ]);
  });

  it("respects the same exclusion set pickNextSuggestion was given, comparing against what it would actually show next", () => {
    const winner = candidate("winner", {
      ingredient_slots: [{ role: "vegetable", ingredient_id: "aret-runt", substitutable: true }],
    });
    const excludedRunnerUp = candidate("excluded", {
      ingredient_slots: [{ role: "vegetable", ingredient_id: "aret-runt", substitutable: true }],
    });
    const realRunnerUp = candidate("real-runner-up", {
      ingredient_slots: [{ role: "vegetable", ingredient_id: "vinter", substitutable: true }],
    });

    const ranked = rankCandidates(seasonalityData, [winner, excludedRunnerUp, realRunnerUp], zero, 7);
    const picked = ranked.find((c) => c.template.id === "winner")!;
    const excluded = new Set(["excluded"]);

    // Against the excluded candidate (identical seasonality) there would be nothing
    // to credit; against the real next-in-line (out of season) seasonality qualifies.
    expect(explainSuggestion(seasonalityData, ranked, excluded, picked, undefined, zero, 7)).toEqual([
      "in_season",
    ]);
  });

  it("is silent, not a crash, when the picked candidate is the only one remaining", () => {
    const only = neutralCandidate("only");

    const ranked = rankCandidates(seasonalityData, [only], zero, 1);
    const picked = ranked[0]!;

    expect(explainSuggestion(seasonalityData, ranked, new Set(), picked, undefined, zero, 1)).toEqual([]);
  });
});
