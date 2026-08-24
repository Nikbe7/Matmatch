import { describe, expect, it } from "vitest";
import { AllergySchema } from "../schema/allergyDietary.js";
import {
  NEUTRAL_PREFERENCE_WEIGHTS,
  PREFERENCE_WEIGHT_MAX,
  PREFERENCE_WEIGHT_MIN,
  type PreferenceWeights,
} from "../schema/preferenceWeights.js";
import { selectCandidateTemplates } from "./candidates.js";
import { loadEngineData } from "./data.js";
import { orderByPantryCoverage, pickDirections } from "./directions.js";
import {
  coveredPantryIngredients,
  distinctPantryItemCount,
  effectiveIngredientIds,
  explainSuggestion,
  pickNextSuggestion,
  rankCandidates,
  toRankingWeights,
} from "./ranking.js";
import { makeConstraints as household } from "./__fixtures__/household.js";

// #152: Tonight's pantry row, and the single ordering rule it shares with the guided
// flow's pantry step.
//
// Against the REAL catalog, like preferenceWeights.test.ts and for the same reason:
// the claims here are about what actual households actually see. "The two screens
// order dishes the same way" is a claim about two real pipelines over real data, and
// a three-template fixture cannot support it.

const data = await loadEngineData();
const rowsByIngredientId = data.allergenMappingByIngredientId;

const MONTH = 7;

/** Slider positions for the sweeps: both extremes plus the two chip levels. */
function uniform(value: number): PreferenceWeights {
  return { price: value, time: value, variation: value, simplicity: value };
}

const WEIGHT_EXTREMES: PreferenceWeights[] = [
  NEUTRAL_PREFERENCE_WEIGHTS,
  uniform(PREFERENCE_WEIGHT_MIN),
  uniform(PREFERENCE_WEIGHT_MAX),
  { price: PREFERENCE_WEIGHT_MAX, time: 0, variation: 0, simplicity: PREFERENCE_WEIGHT_MAX },
  { price: 0, time: PREFERENCE_WEIGHT_MAX, variation: PREFERENCE_WEIGHT_MAX, simplicity: 0 },
];

/**
 * Pantry selections for the sweeps. Not random: a fixed set covering the empty case,
 * one staple, a plausible multi-item cupboard, and a deliberately absurd one — a test
 * that has to be re-run to be believed is not an exhaustive test.
 */
const PANTRY_SELECTIONS: readonly (readonly string[])[] = [
  [],
  ["spagetti"],
  ["spagetti", "gul-lok", "ris"],
  [...data.ingredientsById.keys()],
];

function rankedFor(constraints: ReturnType<typeof household>, preference: PreferenceWeights) {
  const candidates = selectCandidateTemplates(data, constraints);
  return rankCandidates(
    data,
    candidates,
    toRankingWeights(preference),
    MONTH,
    constraints.dietary_flags,
  );
}

describe("orderByPantryCoverage", () => {
  const ranked = rankedFor(household(), NEUTRAL_PREFERENCE_WEIGHTS);

  it("is the identity when the household selected nothing", () => {
    // The step was skipped, which is not the same as "has nothing" — either way it
    // stops being an ordering signal and the score order stands untouched.
    expect(orderByPantryCoverage(data, ranked, []).map((d) => d.template.id)).toEqual(
      ranked.map((candidate) => candidate.template.id),
    );
  });

  it("never adds or drops a candidate — it only reorders", () => {
    for (const pantry of PANTRY_SELECTIONS) {
      const ordered = orderByPantryCoverage(data, ranked, pantry);
      expect(new Set(ordered.map((d) => d.template.id))).toEqual(
        new Set(ranked.map((c) => c.template.id)),
      );
      expect(ordered).toHaveLength(ranked.length);
    }
  });

  it("puts higher coverage first, always", () => {
    for (const pantry of PANTRY_SELECTIONS) {
      const coverage = orderByPantryCoverage(data, ranked, pantry).map((d) =>
        distinctPantryItemCount(d.pantryCoverage),
      );
      const nonIncreasing = coverage.every((value, i) => i === 0 || coverage[i - 1]! >= value);
      expect(nonIncreasing).toBe(true);
    }
  });

  it("keeps the score order inside a coverage bucket", () => {
    const pantry = ["spagetti", "gul-lok", "ris"];
    const ordered = orderByPantryCoverage(data, ranked, pantry);
    const scoreOrder = new Map(ranked.map((candidate, index) => [candidate.template.id, index]));

    // Within one bucket the shared rank order must survive verbatim: coverage decides
    // the bucket, and nothing else about the ordering is this function's business.
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1]!;
      const current = ordered[i]!;
      if (
        distinctPantryItemCount(previous.pantryCoverage) ===
        distinctPantryItemCount(current.pantryCoverage)
      ) {
        expect(scoreOrder.get(previous.template.id)!).toBeLessThan(
          scoreOrder.get(current.template.id)!,
        );
      }
    }
  });

  it("counts an ingredient once even when a dish uses it in two slots", () => {
    for (const pantry of PANTRY_SELECTIONS) {
      for (const direction of orderByPantryCoverage(data, ranked, pantry)) {
        const covered = direction.pantryCoverage.map((entry) => entry.ingredientId);
        expect(new Set(covered).size).toBe(covered.length);
      }
    }
  });
});

describe("Tonight and the guided flow share one pantry ranking input", () => {
  // The acceptance criterion for #152: a pantry selection on Tonight must feed the
  // same ranking input as the same selection in the guided flow. Both go through
  // `orderByPantryCoverage`, and these tests assert the consequence rather than the
  // call graph — a future edit that reintroduces a second rule fails here.

  it.each(PANTRY_SELECTIONS.map((pantry) => [pantry.slice(0, 3).join("+") || "(empty)", pantry]))(
    "credits the same dishes with the same pantry items for selection %s",
    (_label, pantry) => {
      const ranked = rankedFor(household(), NEUTRAL_PREFERENCE_WEIGHTS);

      const tonight = new Map(
        orderByPantryCoverage(data, ranked, pantry).map((d) => [
          d.template.id,
          d.pantryCoverage.map((entry) => entry.ingredientId).sort(),
        ]),
      );

      // The guided flow's own view of the same selection, taken from the full-length
      // direction set with no main-ingredient constraint and no intent.
      const guided = new Map(
        pickDirections(data, ranked, {
          main: { kind: "any" },
          pantryIngredientIds: pantry,
          count: ranked.length,
        }).map((d) => [d.template.id, d.pantryCoverage.map((entry) => entry.ingredientId).sort()]),
      );

      expect(tonight).toEqual(guided);
    },
  );

  it("suggests the same dish both ways for the same pantry, with nothing excluded", () => {
    const pantry = ["spagetti", "gul-lok", "ris"];
    const ranked = rankedFor(household(), NEUTRAL_PREFERENCE_WEIGHTS);

    const tonightPick = pickNextSuggestion(
      orderByPantryCoverage(data, ranked, pantry),
      new Set(),
      undefined,
    );
    const [guidedFirst] = pickDirections(data, ranked, {
      main: { kind: "any" },
      pantryIngredientIds: pantry,
    });

    expect(tonightPick?.template.id).toBe(guidedFirst?.template.id);
  });
});

describe("the pantry_match reason", () => {
  const ranked = rankedFor(household(), NEUTRAL_PREFERENCE_WEIGHTS);
  const weights = toRankingWeights(NEUTRAL_PREFERENCE_WEIGHTS);

  function explain(pantry: readonly string[], excluded: ReadonlySet<string> = new Set()) {
    const ordered = orderByPantryCoverage(data, ranked, pantry);
    const picked = pickNextSuggestion(ordered, excluded, undefined)!;
    return {
      picked,
      codes: explainSuggestion(
        data,
        ordered,
        excluded,
        picked,
        undefined,
        weights,
        MONTH,
        [],
        undefined,
        pantry,
      ),
    };
  }

  it("fires when coverage promoted the dish over a better-scoring one", () => {
    const pantry = ["spagetti", "gul-lok", "ris"];
    const { picked, codes } = explain(pantry);

    // The premise: something really does outscore the pick, so coverage is what put
    // it in front. Without this the assertion below would pass vacuously.
    const ordered = orderByPantryCoverage(data, ranked, pantry);
    expect(ordered.some((candidate) => candidate.score > picked.score)).toBe(true);
    expect(coveredPantryIngredients(data, picked, new Set(pantry)).length).toBeGreaterThan(0);

    expect(codes).toContain("pantry_match");
  });

  it("comes first, ahead of every other reason", () => {
    const { codes } = explain(["spagetti", "gul-lok", "ris"]);
    expect(codes[0]).toBe("pantry_match");
  });

  it("stays silent when the household selected no pantry at all", () => {
    expect(explain([]).codes).not.toContain("pantry_match");
  });

  it("stays silent when the top-scoring dish would have been picked anyway", () => {
    // Selecting everything gives every dish full coverage of whatever it uses, but
    // the ordering only promotes when a *better-scoring* dish sits in a lower bucket.
    // Where the score winner also leads on coverage, the pantry decided nothing and
    // claiming otherwise would credit a tap that changed no outcome.
    const pantry = [...data.ingredientsById.keys()];
    const ordered = orderByPantryCoverage(data, ranked, pantry);
    const picked = pickNextSuggestion(ordered, new Set(), undefined)!;

    if (!ordered.some((candidate) => candidate.score > picked.score)) {
      expect(explain(pantry).codes).not.toContain("pantry_match");
    }
  });

  it("suppresses score-term reasons, which would describe the wrong comparison", () => {
    // `runnerUp` sits in a lower coverage bucket when coverage fired, so a cost or
    // time gap between the two is a fact about the pair, not what drove the pick.
    const { codes } = explain(["spagetti", "gul-lok", "ris"]);
    if (codes.includes("pantry_match")) {
      expect(codes).not.toContain("cost_preference");
      expect(codes).not.toContain("time_preference");
      expect(codes).not.toContain("in_season");
    }
  });
});

describe("pantry input can never affect allergy or dietary filtering", () => {
  // CLAUDE.md non-negotiable. Exhaustive over the locked allergy vocabulary crossed
  // with slider extremes and pantry selections — not sampled.
  //
  // Structurally this is unreachable: `selectCandidateTemplates` takes neither weights
  // nor a pantry, and `orderByPantryCoverage` is a sort. These tests assert it anyway,
  // because "unreachable" is a claim about today's call graph and this is the file
  // that has to notice when it stops being true.

  it.each(AllergySchema.options)(
    "shows an identical candidate set for a household allergic to %s, at every slider extreme and pantry selection",
    (allergy) => {
      const constraints = household({ allergies: [allergy] });
      const reference = new Set(
        rankedFor(constraints, NEUTRAL_PREFERENCE_WEIGHTS).map((c) => c.template.id),
      );

      for (const preference of WEIGHT_EXTREMES) {
        const ranked = rankedFor(constraints, preference);
        for (const pantry of PANTRY_SELECTIONS) {
          const ids = new Set(
            orderByPantryCoverage(data, ranked, pantry).map((d) => d.template.id),
          );
          // Set equality: pantry and weights may reorder, and only reorder. One
          // template added or removed would mean ordering had reached into filtering.
          expect(ids).toEqual(reference);
        }
      }
    },
  );

  it.each(AllergySchema.options)(
    "never surfaces an ingredient containing %s, at every slider extreme and pantry selection",
    (allergy) => {
      const constraints = household({ allergies: [allergy] });

      for (const preference of WEIGHT_EXTREMES) {
        const ranked = rankedFor(constraints, preference);
        for (const pantry of PANTRY_SELECTIONS) {
          const offenders = orderByPantryCoverage(data, ranked, pantry)
            .flatMap((direction) => effectiveIngredientIds(direction))
            .filter((ingredientId) => {
              const row = rowsByIngredientId.get(ingredientId);
              // Fail-safe: a missing or unverified row disqualifies as surely as one
              // that lists the allergen.
              return (
                !row || row.verification_status !== "verified" || row.allergens.includes(allergy)
              );
            });

          expect(offenders).toEqual([]);
        }
      }
    },
  );

  it.each(AllergySchema.options)(
    "never lets a pantry selection reintroduce %s — selecting the whole catalog changes nothing",
    (allergy) => {
      // The adversarial case: the household "has" every ingredient in the catalog,
      // including the ones its own allergy excludes. Coverage is computed over the
      // safe candidate set, so an excluded ingredient has no dish to promote.
      const constraints = household({ allergies: [allergy] });
      const everything = [...data.ingredientsById.keys()];

      for (const preference of WEIGHT_EXTREMES) {
        const ordered = orderByPantryCoverage(data, rankedFor(constraints, preference), everything);
        const covered = ordered.flatMap((direction) =>
          direction.pantryCoverage.map((entry) => entry.ingredientId),
        );
        const offenders = covered.filter((ingredientId) =>
          rowsByIngredientId.get(ingredientId)?.allergens.includes(allergy),
        );

        expect(offenders).toEqual([]);
      }
    },
  );
});
