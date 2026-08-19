import { z } from "zod";

// The household's four preference axes (DECISION_LOG 2026-08-16, issue #157).
//
// This module is the ONE definition of what an axis is and what values it may take.
// Both the persistent baseline (stored on the household, edited by the sliders) and
// the session delta (produced by the Tonight adjustment chips, discarded when the
// session ends) are values of `PreferenceWeights` — they differ in lifetime, never in
// vocabulary. That is the whole point of putting this in `src/schema/`: the moment
// there are two axis definitions, "Billigare" and the Pris slider become two
// mechanics that can disagree about what the household asked for.
//
// Deliberately product-domain, not engine-domain. A value here is a slider position
// (0–100, in steps of 5, exactly what the reference control emits), never a score
// multiplier. The single translation into engine units is `toRankingWeights` in
// src/engine/ranking.ts, which is where the calibration against
// SEASONALITY_WEIGHT/FAMILIARITY_STEP_WEIGHT/RECENCY_PENALTY_WEIGHT lives. Nothing
// else may convert between the two spaces.
//
// Nothing here touches allergy or dietary filtering, and it must never learn to:
// `selectCandidateTemplates` takes no weights at all, so safety-critical exclusion is
// structurally out of reach of anything a household can drag a slider to.
// (src/engine/preferenceWeights.test.ts asserts that exhaustively.)

/**
 * The axes, in the order the "Vad är viktigt för er?" block presents them.
 *
 * Adding an axis means adding curated data behind it first — DECISION_LOG 2026-08-16:
 * "no axis may exist without curated data behind it".
 */
export const PREFERENCE_AXES = ["price", "time", "variation", "simplicity"] as const;
export type PreferenceAxis = (typeof PREFERENCE_AXES)[number];

export const PREFERENCE_WEIGHT_MIN = 0;
export const PREFERENCE_WEIGHT_MAX = 100;

/**
 * Slider granularity. 5 rather than 1 because the value is a stated preference, not a
 * measurement: 21 positions is already finer than the three hint bands the control
 * renders ("Spelar liten/viss/stor roll"), and a coarse grid keeps the stored value
 * something a human could reasonably have meant.
 *
 * Enforced in three places on purpose — this schema, the `preference_weight` domain in
 * the migration, and the query parser — because the acceptance criterion for #157 is
 * that an out-of-range value is rejected by the schema, not merely by a UI that has
 * not been built yet.
 */
export const PREFERENCE_WEIGHT_STEP = 5;

export const PreferenceWeightSchema = z
  .number()
  .int()
  .min(PREFERENCE_WEIGHT_MIN)
  .max(PREFERENCE_WEIGHT_MAX)
  .refine((value) => value % PREFERENCE_WEIGHT_STEP === 0, {
    message: `must be a multiple of ${PREFERENCE_WEIGHT_STEP}`,
  });

export const PreferenceWeightsSchema = z.object({
  /** "Spelar liten roll" → the engine applies no cost-tier penalty at all. */
  price: PreferenceWeightSchema,
  /** "Spelar liten roll" → the engine applies no prep-time penalty at all. */
  time: PreferenceWeightSchema,
  /**
   * How far to relax the novelty penalty: 0 keeps the full familiarity penalty
   * ("Vi håller oss till sådant ni känner igen"), 100 removes it ("Vi lyfter fram
   * rätter ni inte lagat förut").
   */
  variation: PreferenceWeightSchema,
  /**
   * STORED BUT INERT — and it must NOT be rendered.
   *
   * There is no curated effort/difficulty signal on `RecipeTemplate` yet; #151 is the
   * data pass that creates one, and until it lands this axis cannot change a single
   * ranking decision (asserted in src/engine/preferenceWeights.test.ts). The
   * "Vad är viktigt för er?" block therefore shows THREE sliders, not four.
   *
   * Do not add the fourth slider "for completeness". A control the household drags
   * with no observable consequence teaches them the controls are decorative, which is
   * strictly worse than a control that is simply absent — and it is the exact
   * objection that got sliders rejected once already (DECISION_LOG 2026-07-31, the
   * "no observable consequence per notch" half). It is persisted now only so that
   * #153's "Enklare" chip expresses a delta on an axis that already exists rather than
   * inventing a parallel one.
   */
  simplicity: PreferenceWeightSchema,
});
export type PreferenceWeights = z.infer<typeof PreferenceWeightsSchema>;

/**
 * The value every household starts at, and the value the migration backfills.
 *
 * All zeros — "spelar liten roll" on every axis — because that is what reproduces the
 * engine's behaviour from before this existed, exactly. A household that has never
 * touched a slider has expressed nothing, and the ranking it gets is the ranking it
 * got yesterday. Backward compatibility here is structural, not a number that happens
 * to work out: see `toRankingWeights`, where each axis's zero is defined as its
 * pre-#157 constant.
 */
export const NEUTRAL_PREFERENCE_WEIGHTS: PreferenceWeights = {
  price: 0,
  time: 0,
  variation: 0,
  simplicity: 0,
};

/**
 * A session-scoped adjustment, in the same units as the baseline.
 *
 * Partial and signed: a chip moves the axes it is about and says nothing about the
 * rest. An omitted axis and an explicit `0` mean the same thing by construction —
 * `combinePreferenceWeights` reads a missing axis as 0 — which is what makes "the same
 * delta gives the same result regardless of which path it arrived by" true rather than
 * merely tested.
 */
export type PreferenceWeightsDelta = Partial<Record<PreferenceAxis, number>>;

function clampToRange(value: number): number {
  return Math.min(PREFERENCE_WEIGHT_MAX, Math.max(PREFERENCE_WEIGHT_MIN, value));
}

/**
 * The household's baseline with this session's delta applied on top — per axis, summed
 * and clamped to the slider's own range.
 *
 * Pure, total, and free of I/O so the combination rule can be tested directly rather
 * than through a route. Clamping rather than rejecting is deliberate: a delta is a
 * relative nudge, and a household already at 100 tapping "Billigare" again is asking
 * for something reasonable that simply has no further to go — an error there would be
 * the app arguing with a tap.
 *
 * Both inputs are expected to be validated (`PreferenceWeightsSchema` for the baseline,
 * the query parser for the delta), so both are multiples of `PREFERENCE_WEIGHT_STEP`
 * and the clamped sum is one too. This function does not re-validate: it is called on
 * every ranked request, and the guarantee belongs at the boundaries where the values
 * enter.
 */
export function combinePreferenceWeights(
  baseline: PreferenceWeights,
  delta: PreferenceWeightsDelta = {},
): PreferenceWeights {
  return {
    price: clampToRange(baseline.price + (delta.price ?? 0)),
    time: clampToRange(baseline.time + (delta.time ?? 0)),
    variation: clampToRange(baseline.variation + (delta.variation ?? 0)),
    simplicity: clampToRange(baseline.simplicity + (delta.simplicity ?? 0)),
  };
}
