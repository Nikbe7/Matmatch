import { describe, expect, it } from "vitest";
import { AllergySchema, DietaryFlagSchema } from "../schema/allergyDietary.js";
import {
  combinePreferenceWeights,
  NEUTRAL_PREFERENCE_WEIGHTS,
  PREFERENCE_AXES,
  PREFERENCE_WEIGHT_MAX,
  PREFERENCE_WEIGHT_STEP,
  PreferenceWeightsSchema,
  type PreferenceWeights,
} from "../schema/preferenceWeights.js";
import { selectCandidateTemplates } from "./candidates.js";
import { loadEngineData } from "./data.js";
import {
  effectiveIngredientIds,
  rankCandidates,
  toRankingWeights,
  NEUTRAL_RANKING_WEIGHTS,
  type RankingWeights,
} from "./ranking.js";
import { makeConstraints as household } from "./__fixtures__/household.js";

// The four preference axes (#157): the persistent household baseline, the session
// delta, and the single bridge between slider notches and engine weights.
//
// Every test here runs against the REAL catalog rather than synthetic fixtures. The
// claims being made are about what actual households actually see — "the migration
// changes nobody's ranking", "no slider position can widen an allergy filter" — and a
// three-template fixture cannot support either of them.

const data = await loadEngineData();

/**
 * The curated allergen mapping, read straight off the loaded catalog — the same index
 * src/engine/candidates.test.ts checks against. Asserted independently of the engine so
 * a filtering bug cannot hide behind the engine's own view of the data.
 */
const rowsByIngredientId = data.allergenMappingByIngredientId;

/**
 * The engine constants `src/engine/ranking.ts` scored with BEFORE #157, written out as
 * literals rather than derived from anything this change can move.
 *
 * That is the point: if a future edit alters `MAX_AXIS_RANKING_WEIGHT`,
 * `NEUTRAL_FAMILIARITY_STEP_WEIGHT`, or the shape of `toRankingWeights`, the neutral
 * baseline stops reproducing these numbers and the backward-compatibility tests below
 * fail. Deriving them from the module under test would make those tests tautologies.
 */
const PRE_157_WEIGHTS: RankingWeights = { price: 0, time: 0, familiarity: 1.5 };

/** The old chip levels, in the raw engine units the query string used to carry. */
const PRE_157_CHIP_LEVEL_1 = 1;
const PRE_157_CHIP_LEVEL_2 = 3;

/** The notch each of those levels became — `WEIGHT_LEVELS` in web/src/refinement.ts. */
const CHIP_NOTCH_LEVEL_1 = 35;
const CHIP_NOTCH_LEVEL_2 = 100;

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/**
 * The household profiles the whole-library assertions sweep over: unconstrained, each
 * dietary flag on its own, and one heavily-allergic profile — so "the whole template
 * library" means the library as seen through every materially different candidate set,
 * not just the widest one.
 */
const PROFILES = [
  { label: "no constraints", constraints: household() },
  { label: "vegetarian", constraints: household({ dietary_flags: ["vegetarian"] }) },
  { label: "vegan", constraints: household({ dietary_flags: ["vegan"] }) },
  { label: "gluten + dairy", constraints: household({ allergies: ["gluten", "dairy_lactose"] }) },
];

function rankedIds(constraints: ReturnType<typeof household>, weights: RankingWeights, month: number): string[] {
  const candidates = selectCandidateTemplates(data, constraints);
  return rankCandidates(data, candidates, weights, month, constraints.dietary_flags).map(
    (candidate) => candidate.template.id,
  );
}

/** Every axis at the same notch — a cheap way to sweep the whole slider range. */
function uniform(value: number): PreferenceWeights {
  return PreferenceWeightsSchema.parse({
    price: value,
    time: value,
    variation: value,
    simplicity: value,
  });
}

describe("toRankingWeights — the one bridge between slider notches and engine units", () => {
  it("maps the neutral baseline onto exactly the pre-#157 constants", () => {
    // The migration's defaults are all zeros, so this is the assertion that a household
    // which has never touched a slider is scored with the constants the engine used
    // before the sliders existed. Not "close to" — equal.
    expect(toRankingWeights(NEUTRAL_PREFERENCE_WEIGHTS)).toEqual(PRE_157_WEIGHTS);
    expect(NEUTRAL_RANKING_WEIGHTS).toEqual(PRE_157_WEIGHTS);
  });

  it("gives a household at the migration's defaults the identical ranking, over the whole library", () => {
    // The headline acceptance criterion for #157, and the reason the defaults are 0
    // rather than a tidy-looking midpoint: no existing row may land in a state where
    // its ordering differs from what it was before the migration ran.
    for (const profile of PROFILES) {
      for (const month of ALL_MONTHS) {
        expect(rankedIds(profile.constraints, toRankingWeights(NEUTRAL_PREFERENCE_WEIGHTS), month)).toEqual(
          rankedIds(profile.constraints, PRE_157_WEIGHTS, month),
        );
      }
    }
  });

  it("raises price and time linearly, and lowers the familiarity penalty as variation rises", () => {
    expect(toRankingWeights(uniform(PREFERENCE_WEIGHT_MAX))).toEqual({
      price: 3,
      time: 3,
      // The inversion: high Variation means LESS novelty penalty. A sign error here
      // would make "Vi lyfter fram rätter ni inte lagat förut" bury unfamiliar dishes.
      familiarity: 0,
    });
    expect(toRankingWeights(uniform(50)).familiarity).toBeCloseTo(0.75, 10);
  });

  it("never produces a negative or out-of-range engine weight, at any notch", () => {
    for (let notch = 0; notch <= PREFERENCE_WEIGHT_MAX; notch += PREFERENCE_WEIGHT_STEP) {
      const weights = toRankingWeights(uniform(notch));

      for (const value of Object.values(weights)) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(3);
      }
    }
  });

  it("discards simplicity entirely — the axis is stored but inert until #151", () => {
    // The guarantee behind "do not render the fourth slider". If this test ever fails
    // because simplicity started mattering, the slider may ship — and not before.
    for (let notch = 0; notch <= PREFERENCE_WEIGHT_MAX; notch += PREFERENCE_WEIGHT_STEP) {
      expect(toRankingWeights({ ...NEUTRAL_PREFERENCE_WEIGHTS, simplicity: notch })).toEqual(
        toRankingWeights(NEUTRAL_PREFERENCE_WEIGHTS),
      );
    }
  });

  it("leaves the whole library's order untouched at every simplicity notch", () => {
    for (const profile of PROFILES) {
      const reference = rankedIds(profile.constraints, toRankingWeights(NEUTRAL_PREFERENCE_WEIGHTS), 7);

      for (let notch = 0; notch <= PREFERENCE_WEIGHT_MAX; notch += PREFERENCE_WEIGHT_STEP) {
        const weights = toRankingWeights({ ...NEUTRAL_PREFERENCE_WEIGHTS, simplicity: notch });
        expect(rankedIds(profile.constraints, weights, 7)).toEqual(reference);
      }
    }
  });
});

describe("chip levels moved to slider notches without moving the ranking (#157, fork A)", () => {
  // THE BLOCKER for this change. Converting the adjustment chips from raw engine
  // weights to slider notches shifts level 1 from exactly 1.00 to 35/100 * 3 = 1.05.
  // That is a change of units, and it is only allowed to be a change of units: if a
  // single ordering anywhere in the library moves, the conversion is not behaviour-
  // preserving and the level must be re-picked (or the fork revisited) rather than the
  // test relaxed.
  it("level 1 ranks identically at 1.00 and at 1.05, over the whole library and every month", () => {
    for (const axis of ["price", "time"] as const) {
      const before: RankingWeights = { ...PRE_157_WEIGHTS, [axis]: PRE_157_CHIP_LEVEL_1 };
      const after = toRankingWeights({ ...NEUTRAL_PREFERENCE_WEIGHTS, [axis]: CHIP_NOTCH_LEVEL_1 });

      expect(after[axis]).toBeCloseTo(1.05, 10);

      for (const profile of PROFILES) {
        for (const month of ALL_MONTHS) {
          expect(rankedIds(profile.constraints, after, month)).toEqual(
            rankedIds(profile.constraints, before, month),
          );
        }
      }
    }
  });

  it("level 2 is numerically unchanged at 3", () => {
    for (const axis of ["price", "time"] as const) {
      const after = toRankingWeights({ ...NEUTRAL_PREFERENCE_WEIGHTS, [axis]: CHIP_NOTCH_LEVEL_2 });
      expect(after[axis]).toBe(PRE_157_CHIP_LEVEL_2);
    }
  });

  it("keeps both chip notches on the slider's own step grid", () => {
    // A chip that lands between notches would produce a baseline the sliders could not
    // express, i.e. two scales again by the back door.
    for (const notch of [CHIP_NOTCH_LEVEL_1, CHIP_NOTCH_LEVEL_2]) {
      expect(() => PreferenceWeightsSchema.parse({ ...NEUTRAL_PREFERENCE_WEIGHTS, price: notch })).not.toThrow();
    }
  });
});

describe("combinePreferenceWeights — baseline plus session delta", () => {
  const baseline = PreferenceWeightsSchema.parse({
    price: 20,
    time: 40,
    variation: 60,
    simplicity: 10,
  });

  it("adds the delta per axis and leaves untouched axes alone", () => {
    expect(combinePreferenceWeights(baseline, { price: 35 })).toEqual({
      price: 55,
      time: 40,
      variation: 60,
      simplicity: 10,
    });
  });

  it("treats an omitted axis and an explicit zero as the same delta", () => {
    // "The same delta gives the same result regardless of which path it came in by" —
    // an omitted chip, a chip explicitly at level 0, and no delta object at all.
    const viaOmission = combinePreferenceWeights(baseline, { price: 35 });
    const viaExplicitZeros = combinePreferenceWeights(baseline, {
      price: 35,
      time: 0,
      variation: 0,
      simplicity: 0,
    });

    expect(viaOmission).toEqual(viaExplicitZeros);
    expect(combinePreferenceWeights(baseline, {})).toEqual(combinePreferenceWeights(baseline));
    expect(combinePreferenceWeights(baseline, {})).toEqual(baseline);
  });

  it("is deterministic — the same inputs give the same output every time", () => {
    const delta = { price: 35, variation: 15 };
    const results = Array.from({ length: 5 }, () => combinePreferenceWeights(baseline, delta));

    for (const result of results) expect(result).toEqual(results[0]);
  });

  it("does not mutate either input", () => {
    const frozenBaseline = { ...baseline };
    const delta = { price: 35 };
    const frozenDelta = { ...delta };

    combinePreferenceWeights(baseline, delta);

    expect(baseline).toEqual(frozenBaseline);
    expect(delta).toEqual(frozenDelta);
  });

  it("clamps to the slider's range rather than rejecting an over-eager tap", () => {
    // A household already at the top tapping "Billigare" again is asking for something
    // reasonable that has nowhere further to go. Erroring there would be the app
    // arguing with a tap.
    const atTop = PreferenceWeightsSchema.parse(uniform(PREFERENCE_WEIGHT_MAX));
    expect(combinePreferenceWeights(atTop, { price: 35 }).price).toBe(PREFERENCE_WEIGHT_MAX);
    expect(combinePreferenceWeights(NEUTRAL_PREFERENCE_WEIGHTS, { price: -35 }).price).toBe(0);
  });

  it("always returns a value the schema accepts, for every notch pairing", () => {
    // Both inputs are on the step-5 grid, so the clamped sum must be too — the property
    // that lets the result be stored straight back without re-snapping.
    for (let base = 0; base <= PREFERENCE_WEIGHT_MAX; base += PREFERENCE_WEIGHT_STEP) {
      for (let delta = -PREFERENCE_WEIGHT_MAX; delta <= PREFERENCE_WEIGHT_MAX; delta += PREFERENCE_WEIGHT_STEP) {
        const combined = combinePreferenceWeights(uniform(base), { price: delta });
        expect(() => PreferenceWeightsSchema.parse(combined)).not.toThrow();
      }
    }
  });

  it("gives the same engine weights whether a preference arrived as baseline or as delta", () => {
    // 20 + 35 as a stored baseline, and 55 dragged onto the slider directly, are the
    // same statement about what the household wants — they must score identically.
    const asDelta = combinePreferenceWeights(baseline, { price: 35 });
    const asBaseline = PreferenceWeightsSchema.parse({ ...baseline, price: 55 });

    expect(toRankingWeights(asDelta)).toEqual(toRankingWeights(asBaseline));

    for (const profile of PROFILES) {
      expect(rankedIds(profile.constraints, toRankingWeights(asDelta), 7)).toEqual(
        rankedIds(profile.constraints, toRankingWeights(asBaseline), 7),
      );
    }
  });
});

describe("PreferenceWeightsSchema — the range is enforced by the schema, not by the UI", () => {
  it("accepts every value on the step grid", () => {
    for (let notch = 0; notch <= PREFERENCE_WEIGHT_MAX; notch += PREFERENCE_WEIGHT_STEP) {
      expect(() => PreferenceWeightsSchema.parse(uniform(notch))).not.toThrow();
    }
  });

  it.each([101, 105, -5, -1, 1000])("rejects the out-of-range value %s", (value) => {
    for (const axis of PREFERENCE_AXES) {
      expect(() =>
        PreferenceWeightsSchema.parse({ ...NEUTRAL_PREFERENCE_WEIGHTS, [axis]: value }),
      ).toThrow();
    }
  });

  it.each([1, 7, 37, 99, 2.5, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects the off-grid or non-integer value %s",
    (value) => {
      for (const axis of PREFERENCE_AXES) {
        expect(() =>
          PreferenceWeightsSchema.parse({ ...NEUTRAL_PREFERENCE_WEIGHTS, [axis]: value }),
        ).toThrow();
      }
    },
  );

  it("requires all four axes — a partial baseline is not a baseline", () => {
    expect(() => PreferenceWeightsSchema.parse({ price: 0, time: 0, variation: 0 })).toThrow();
  });
});

describe("weights are ranking-only — no slider position can affect allergy or dietary filtering", () => {
  // CLAUDE.md non-negotiable, and the one property of this change that is safety-
  // critical. Exhaustive over the locked allergy vocabulary, not sampled.
  //
  // The structural argument is that `selectCandidateTemplates` is never handed a weight
  // vector at all, so this is unreachable by construction. These tests assert it anyway,
  // because "unreachable by construction" is a claim about today's call graph and this
  // is the file that has to notice when that stops being true.

  const WEIGHT_SWEEP = [0, 5, 35, 50, 100].map(uniform);

  it.each(AllergySchema.options)(
    "shows an identical candidate set at every weight combination for a household allergic to %s",
    (allergy) => {
      const constraints = household({ allergies: [allergy] });
      const reference = new Set(rankedIds(constraints, toRankingWeights(NEUTRAL_PREFERENCE_WEIGHTS), 7));

      for (const preference of WEIGHT_SWEEP) {
        for (const month of ALL_MONTHS) {
          const ids = new Set(rankedIds(constraints, toRankingWeights(preference), month));
          // Set equality, deliberately: weights are allowed to reorder, and only to
          // reorder. A weight that added or removed a single template would mean the
          // score had reached into filtering.
          expect(ids).toEqual(reference);
        }
      }
    },
  );

  it.each(AllergySchema.options)(
    "never surfaces an ingredient containing %s at any weight combination",
    (allergy) => {
      const constraints = household({ allergies: [allergy] });
      for (const preference of WEIGHT_SWEEP) {
        const candidates = selectCandidateTemplates(data, constraints);
        const ranked = rankCandidates(
          data,
          candidates,
          toRankingWeights(preference),
          7,
          constraints.dietary_flags,
        );

        const offenders = ranked
          .flatMap((candidate) => effectiveIngredientIds(candidate))
          .filter((ingredientId) => {
            const row = rowsByIngredientId.get(ingredientId);
            // Fail-safe: a missing row or an unverified row disqualifies as surely as
            // one that lists the allergen.
            return !row || row.verification_status !== "verified" || row.allergens.includes(allergy);
          });

        expect(offenders).toEqual([]);
      }
    },
  );

  it.each(DietaryFlagSchema.options)(
    "shows an identical candidate set at every weight combination for a household declaring %s",
    (flag) => {
      const constraints = household({ dietary_flags: [flag] });
      const reference = new Set(rankedIds(constraints, toRankingWeights(NEUTRAL_PREFERENCE_WEIGHTS), 7));

      for (const preference of WEIGHT_SWEEP) {
        expect(new Set(rankedIds(constraints, toRankingWeights(preference), 7))).toEqual(reference);
      }
    },
  );

  it.each(AllergySchema.options)(
    "keeps %s excluded even for an allergic household that also declared vegan",
    (allergy) => {
      const constraints = household({ allergies: [allergy], dietary_flags: ["vegan"] });
      for (const preference of WEIGHT_SWEEP) {
        const candidates = selectCandidateTemplates(data, constraints);
        const ranked = rankCandidates(
          data,
          candidates,
          toRankingWeights(preference),
          7,
          constraints.dietary_flags,
        );

        const offenders = ranked
          .flatMap((candidate) => effectiveIngredientIds(candidate))
          .filter((ingredientId) => rowsByIngredientId.get(ingredientId)?.allergens.includes(allergy));

        expect(offenders).toEqual([]);
      }
    },
  );
});
