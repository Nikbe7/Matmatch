// The wording of the three preference sliders (#158) — label, level text and hint —
// and the one rule for when that wording is allowed to change.
//
// This is copy with a specification behind it, which is why it lives in its own
// module with its own tests rather than inline in a component. DECISION_LOG
// 2026-08-16 states the constraint plainly: a slider's hint must change at
// BEHAVIOURAL thresholds, never once per notch. One notch of 5 is worth 0.15 engine
// points per enum step, which is below `SEASONALITY_WEIGHT` (0.25) — so at the bottom
// of a slider a single step can be genuinely invisible in the ranking. Hint text that
// moved on every step would promise a consequence the engine does not deliver, which
// is the "no observable consequence per notch" objection that got sliders rejected
// once already (2026-07-31), smuggled back in through the copy.
//
// Four bands per axis, and the thresholds are the engine's own constants rather than
// round numbers that felt right:
//
//   notch → engine weight is `notch × 0.03` (MAX_AXIS_RANKING_WEIGHT / 100).
//
//   0        weight 0      — the axis contributes nothing at all.
//   5–45     0.15–1.35     — expressed, but under one full familiarity step (1.5), so
//                            an unfamiliar or out-of-season dish can still win.
//   50–95    1.5–2.85      — matches or beats a familiarity step.
//   100      3.0           — beats the largest possible familiarity gap (two steps).
//
// What no band says is "always". `RECENCY_PENALTY_WEIGHT` is 5.0 — larger than any
// axis can reach — so a dish cooked three days ago still loses no matter where the
// household drags anything. A hint promising otherwise would be the same class of
// error as an AI-invented cost figure: a number-shaped promise the engine cannot keep.

/**
 * The axes with a slider. Four since #153 — `simplicity` joins the other three now
 * that #151 has curated `effort_level`, in the same register and with no marking that
 * it is new.
 */
export const SLIDER_AXES = ["price", "time", "variation", "simplicity"] as const;
export type SliderAxis = (typeof SLIDER_AXES)[number];

export const PREFERENCE_STEP = 5;
export const PREFERENCE_MIN = 0;
export const PREFERENCE_MAX = 100;

/** The notch at which an expressed preference starts matching a familiarity step. */
const STRONG_THRESHOLD = 50;

export interface HintBand {
  /** The lowest notch this band covers. */
  from: number;
  /** The muted text beside the label. */
  level: string;
  /** The sentence under the control, in plain prose — no numbers, no percentages. */
  hint: string;
}

/**
 * Bands are listed low to high; `hintFor` takes the last one whose `from` the value
 * has reached. Every axis defines all four, so there is no fall-through case and no
 * value a slider can hold that has no wording.
 */
export interface AxisCopy {
  label: string;
  bands: readonly [HintBand, HintBand, HintBand, HintBand];
}

export const AXIS_COPY: Record<SliderAxis, AxisCopy> = {
  price: {
    label: "Pris",
    bands: [
      {
        from: 0,
        level: "Spelar ingen roll",
        hint: "Vi tittar inte på priset när vi väljer.",
      },
      {
        from: 5,
        level: "Spelar viss roll",
        hint: "Vi lutar åt billigare middagar, men säsong och omväxling kan väga över.",
      },
      {
        from: STRONG_THRESHOLD,
        level: "Spelar stor roll",
        hint: "Vi väljer hellre en billigare middag än något ni sällan lagar.",
      },
      {
        from: PREFERENCE_MAX,
        level: "Spelar störst roll",
        hint: "Vi väljer det billigaste vi kan, så länge ni inte precis lagat det.",
      },
    ],
  },
  time: {
    label: "Tid",
    bands: [
      {
        from: 0,
        level: "Spelar ingen roll",
        hint: "En middag får ta den tid den tar.",
      },
      {
        from: 5,
        level: "Spelar viss roll",
        hint: "Vi lutar åt snabbare middagar, men säsong och omväxling kan väga över.",
      },
      {
        from: STRONG_THRESHOLD,
        level: "Spelar stor roll",
        hint: "Vi väljer hellre en snabb middag än något ni sällan lagar.",
      },
      {
        from: PREFERENCE_MAX,
        level: "Spelar störst roll",
        hint: "Vi väljer det snabbaste vi kan, så länge ni inte precis lagat det.",
      },
    ],
  },
  // The one place the reference's own copy is rewritten rather than reused (#158
  // requires the deviation to be stated). `toRankingWeights` computes
  // `familiarity = 1.5 × (1 − variation/100)`: the axis REMOVES the penalty on dishes
  // the household has not cooked, it never rewards them. The reference's "Vi lyfter
  // fram rätter ni inte lagat förut" promises a boost the engine does not apply, so
  // every band here is worded as levelling rather than promoting.
  variation: {
    label: "Variation",
    bands: [
      {
        from: 0,
        level: "Spelar ingen roll",
        hint: "Vi håller oss till sådant ni känner igen.",
      },
      {
        from: 5,
        level: "Spelar viss roll",
        hint: "Vi föreslår något ovant ibland, men det välbekanta ligger närmast till hands.",
      },
      {
        from: STRONG_THRESHOLD,
        level: "Spelar stor roll",
        hint: "Vi drar oss inte för rätter ni aldrig lagat.",
      },
      {
        from: PREFERENCE_MAX,
        level: "Spelar störst roll",
        hint: "Nya rätter får samma chans som era vanliga.",
      },
    ],
  },
  // #153, gated on #151's curated effort_level. Low is an active choice, not a
  // deficiency, and high is a choice too, not a mark of ambition — see the field
  // comment on `effort_level` in src/schema/recipeTemplate.ts. Structurally the same
  // bands as price/time, so the axis rises linearly the same way in toRankingWeights.
  simplicity: {
    label: "Enkelhet",
    bands: [
      {
        from: 0,
        level: "Spelar ingen roll",
        hint: "Det får gärna kräva lite pyssel i köket.",
      },
      {
        from: 5,
        level: "Spelar viss roll",
        hint: "Vi lutar åt enklare middagar, men säsong och omväxling kan väga över.",
      },
      {
        from: STRONG_THRESHOLD,
        level: "Spelar stor roll",
        hint: "Vi väljer hellre en enklare middag än något ni sällan lagar.",
      },
      {
        from: PREFERENCE_MAX,
        level: "Spelar störst roll",
        hint: "Få moment, en panna, minimal disk.",
      },
    ],
  },
};

/** The band a value falls in — the last one it has reached. */
export function bandFor(axis: SliderAxis, value: number): HintBand {
  const { bands } = AXIS_COPY[axis];
  let match: HintBand = bands[0];
  for (const band of bands) if (value >= band.from) match = band;
  return match;
}

/**
 * The accessible name for the control: the label plus the level in words, so a screen
 * reader hears what the household reads and never a bare number out of context. Same
 * discipline as the chip dot meters (DECISION_LOG 2026-08-05).
 */
export function sliderAccessibleName(axis: SliderAxis, value: number): string {
  return `${AXIS_COPY[axis].label}, ${bandFor(axis, value).level.toLowerCase()}`;
}
