import { describe, expect, it } from "vitest";
import { CostTierSchema } from "../schema/ingredient.js";
import { PrepTimeBandSchema } from "../schema/recipeTemplate.js";
import { HouseholdSchema } from "../schema/household.js";
import type { CandidateTemplate } from "./candidates.js";
import { selectCandidateTemplates } from "./candidates.js";
import { loadEngineData } from "./data.js";
import {
  costTierIndex,
  inSeasonFraction,
  pickTonight,
  prepTimeIndex,
  rankCandidates,
  scoreCandidate,
  type RankingWeights,
} from "./ranking.js";
import { makeEngineData, makeIngredient, makeTemplate } from "./__fixtures__/engineData.js";

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

// --- Real-data assertions ------------------------------------------------------

const data = await loadEngineData();
const noRestrictions = HouseholdSchema.parse({
  members: [{ type: "adult", portion_factor: 1 }],
  allergies: [],
  dietary_flags: [],
});

describe("rankCandidates — over the real candidate set", () => {
  const candidates = selectCandidateTemplates(data, noRestrictions);

  it("ranks every candidate exactly once, in non-decreasing score order", () => {
    const ranked = rankCandidates(data, candidates, { cost: 1, time: 1 }, 8);

    // 156, not 170: the meal_types hard filter (#68) now excludes the 14
    // breakfast/lunch-only templates from the dinner-facing candidate set.
    expect(ranked).toHaveLength(156);
    expect(new Set(ranked.map((r) => r.template.id)).size).toBe(156);
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
