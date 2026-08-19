import { describe, expect, it } from "vitest";
import {
  AXIS_COPY,
  PREFERENCE_MAX,
  PREFERENCE_MIN,
  PREFERENCE_STEP,
  SLIDER_AXES,
  bandFor,
  sliderAccessibleName,
} from "./preferenceHints";

// #158: the hint copy and, more importantly, the rule about when it may change.
//
// DECISION_LOG 2026-08-16: the smallest expressed preference (one notch of 5) is worth
// 0.15 engine points per enum step, below `SEASONALITY_WEIGHT` (0.25), so a single step
// is deliberately not always visible in the ranking. Hint text that moved per notch
// would promise a consequence the engine does not deliver. These tests are what stops
// that from creeping back in through a well-meant copy edit.

/** Every position a slider can actually hold: 0, 5, 10 … 100. */
const ALL_VALUES = Array.from(
  { length: (PREFERENCE_MAX - PREFERENCE_MIN) / PREFERENCE_STEP + 1 },
  (_, i) => PREFERENCE_MIN + i * PREFERENCE_STEP,
);

describe("the slider axes", () => {
  it("is exactly three — enkelhet is not among them", () => {
    // #151 has produced no curated effort signal, so a fourth slider would change
    // nothing observable. A control with no consequence is the objection that got
    // sliders rejected once already (DECISION_LOG 2026-07-31).
    expect([...SLIDER_AXES]).toEqual(["price", "time", "variation"]);
    expect(SLIDER_AXES).not.toContain("simplicity");
  });
});

describe("hint bands", () => {
  it.each(SLIDER_AXES)("gives %s a hint at every position the slider can hold", (axis) => {
    for (const value of ALL_VALUES) {
      const band = bandFor(axis, value);
      expect(band.hint.length).toBeGreaterThan(0);
      expect(band.level.length).toBeGreaterThan(0);
    }
  });

  it.each(SLIDER_AXES)("changes %s's wording at most three times across the whole scale", (axis) => {
    // Four bands means three transitions. "Rather three or four formulations than
    // twenty that lie about the precision" — a hint per notch is the failure mode.
    const changes = ALL_VALUES.filter(
      (value, i) => i > 0 && bandFor(axis, value).hint !== bandFor(axis, ALL_VALUES[i - 1]!).hint,
    );
    expect(changes.length).toBeLessThanOrEqual(3);
  });

  it.each(SLIDER_AXES)("changes %s's wording only at the behavioural thresholds", (axis) => {
    // 0 → expressed, and 50 → matches a full familiarity step (1.5), and 100 → beats
    // the largest familiarity gap. Nothing else is a real change in what the engine
    // does, so nothing else may be a change in what the copy claims.
    const changesAt = ALL_VALUES.filter(
      (value, i) => i > 0 && bandFor(axis, value).hint !== bandFor(axis, ALL_VALUES[i - 1]!).hint,
    );
    expect(changesAt).toEqual([5, 50, 100]);
  });

  it.each(SLIDER_AXES)("never states a number or a percentage in %s's copy", (axis) => {
    // Prose to a household, per the reference and the brief: no percent, no minutes,
    // no kronor. A figure here would be a promise the household could check and the
    // engine could not keep.
    for (const band of AXIS_COPY[axis].bands) {
      expect(band.hint).not.toMatch(/\d/);
      expect(band.level).not.toMatch(/\d/);
      expect(band.hint).not.toContain("%");
    }
  });

  it.each(SLIDER_AXES)("never promises %s decides every time", (axis) => {
    // `RECENCY_PENALTY_WEIGHT` is 5.0, larger than any axis can reach (3.0), so a dish
    // cooked two days ago still loses no matter where the slider sits. "Alltid" would
    // be the same class of error as an invented cost figure.
    for (const band of AXIS_COPY[axis].bands) {
      expect(band.hint.toLowerCase()).not.toContain("alltid");
      expect(band.hint.toLowerCase()).not.toContain("aldrig något annat");
    }
  });

  it("does not claim variation promotes new dishes — the engine only stops penalising them", () => {
    // The deviation from the reference (`highHint`: "Vi lyfter fram rätter ni inte
    // lagat förut"). `toRankingWeights` computes familiarity = 1.5 × (1 − variation/100):
    // the axis removes a penalty, it never adds a bonus.
    for (const band of AXIS_COPY.variation.bands) {
      expect(band.hint).not.toContain("lyfter fram");
    }
    expect(bandFor("variation", PREFERENCE_MAX).hint).toBe(
      "Nya rätter får samma chans som era vanliga.",
    );
  });

  it("reads without a double negative at the top of the variation scale", () => {
    expect(bandFor("variation", PREFERENCE_MAX).hint).not.toMatch(/inte.*inte/);
  });
});

describe("sliderAccessibleName", () => {
  it("names the axis and its level in words, never a bare number", () => {
    expect(sliderAccessibleName("price", 0)).toBe("Pris, spelar ingen roll");
    expect(sliderAccessibleName("time", 100)).toBe("Tid, spelar störst roll");
    for (const axis of SLIDER_AXES) {
      for (const value of ALL_VALUES) {
        expect(sliderAccessibleName(axis, value)).not.toMatch(/\d/);
      }
    }
  });
});
