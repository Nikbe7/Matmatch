import type { QuantityUnit, SlotQuantity } from "../schema/recipeTemplate.js";

// Portion scaling for curated slot quantities (#123, DECISION_LOG 2026-08-11).
// Deterministic, pure, no I/O and no AI, like the rest of src/engine/: quantities are
// numbers a household trusts in a shop, so a model never produces one — not when the
// template is authored (they are drafted offline and spot-checked) and least of all
// at request time.
//
// This is the single place scaling and rounding happen. Every surface that shows an
// amount goes through `scaleSlotQuantity`, so the Tonight card, the guided flow and
// the shopping list cannot disagree about how much chicken to buy.

/**
 * Template quantities are authored for four portions.
 *
 * Four is the unit Swedish recipes are written in, which is the point: across ~900
 * slots the drafting pass recalls "500 g köttfärs för 4" rather than inventing a
 * per-person figure, and a hand spot-check compares against numbers in that same
 * familiar register. Scaling divides by this, so it is the one number that would
 * silently rescale the whole library if it changed — treat it as fixed.
 */
export const REFERENCE_PORTIONS = 4;

/**
 * The range a meal's portion count may take (#231).
 *
 * Distinct from `REFERENCE_PORTIONS`, which is what the catalog is *authored* in and
 * must never move. These bound what a household may ask to cook: at least one
 * portion, and not more than a table can plausibly sit. They live here rather than in
 * the client's reducer because both ends now enforce them — the stepper stops at
 * them, and the route clamps to them — and two copies of a bound is how the two ends
 * disagree about what a legal request is.
 *
 * The floor is 1 rather than 0.5 even though a diner set can total less (one adult
 * and one child, adult deselected, is 0.5 — #112): a stepper that opens on a value
 * its own "−" is already disabled for reads as broken. That clamp is exactly why the
 * count and the amounts could disagree before #231 without anyone touching the
 * stepper, so the server now scales to the clamped number rather than the raw total.
 */
export const MIN_PORTIONS = 1;
export const MAX_PORTIONS = 24;

/** `portions` brought into range. Clamping rather than rejecting: the safe answer is
 *  always available, and a client bug should not dead-end a household. */
export function clampPortions(portions: number): number {
  return Math.min(MAX_PORTIONS, Math.max(MIN_PORTIONS, portions));
}

/**
 * A scaled amount, ready to render. Same shape as the authored `SlotQuantity`: a
 * `to_taste` slot scales to itself, because salt is salt at any portion count.
 */
export type ScaledQuantity = SlotQuantity;

/**
 * Round half away from zero, at a given step.
 *
 * JavaScript's `Math.round` rounds half *up* (toward +∞), which for our always-
 * positive amounts is the same thing — this states the intent explicitly so the rule
 * is readable rather than inherited from a language quirk. The `1e6` factor absorbs
 * binary floating-point error before the comparison: 0.35 / 0.5 lands on 0.6999…,
 * and without the scrub a step boundary would round the wrong way roughly at random.
 */
function roundToStep(value: number, step: number): number {
  const steps = Math.round(Math.round((value / step) * 1e6) / 1e6);
  return steps * step;
}

/**
 * How coarsely each unit rounds, and the smallest amount it may show.
 *
 * The rule exists so a scaled amount is one a person can actually buy and measure.
 * 600 g chicken for three diners is 450 g, not 450.0000001, and never 137 g:
 *   - `g` has two bands, because precision that matters at spice/herb scale is noise
 *     at meat scale — 10 g steps below 100 g, 50 g steps above it, so the number on
 *     the list matches how a shop sells the thing.
 *   - `dl`/`msk`/`tsk` step by 0.5, because half a deciliter and half a tablespoon
 *     are real measuring implements and a third of one is not.
 *   - `st`/`klyfta`/`kruka` step by 1: these units count discrete objects, so half an
 *     egg is not an amount, and rounding up to a whole is both cookable and correct
 *     to buy.
 *   - `krm` steps by 1 for the same reason in a different guise: a kryddmått is
 *     already the smallest thing a Swedish kitchen measures with, so there is no
 *     finer step to round to.
 * The floor stops a small household from being told to use 0 of an ingredient the
 * dish is defined by — scaling may shrink an amount, never to nothing.
 */
interface RoundingRule {
  /** Step at this amount's magnitude. */
  step: (scaled: number) => number;
  /** Smallest amount this unit may render. */
  minimum: number;
}

const ROUNDING_RULES: Readonly<Record<QuantityUnit, RoundingRule>> = {
  g: { step: (scaled) => (scaled < 100 ? 10 : 50), minimum: 10 },
  dl: { step: () => 0.5, minimum: 0.5 },
  msk: { step: () => 0.5, minimum: 0.5 },
  tsk: { step: () => 0.5, minimum: 0.5 },
  krm: { step: () => 1, minimum: 1 },
  st: { step: () => 1, minimum: 1 },
  klyfta: { step: () => 1, minimum: 1 },
  kruka: { step: () => 1, minimum: 1 },
};

/**
 * The amount for `portions` diners, rounded to something buyable.
 *
 * `portions` is the household's raw adult-equivalent total (`totalPortions`), so it
 * is routinely fractional — 2 adults + 1 child is 2.7, and the rounding rule is what
 * turns that into a number worth printing. A non-finite or non-positive portion count
 * is treated as the reference count rather than throwing: the engine has no opinion
 * about how a caller got there, and a shopping list with reference amounts is far
 * better than one that fails to render.
 */
export function scaleSlotQuantity(quantity: SlotQuantity, portions: number): ScaledQuantity {
  if (quantity.kind === "to_taste") return quantity;

  const factor =
    Number.isFinite(portions) && portions > 0 ? portions / REFERENCE_PORTIONS : 1;
  const scaled = quantity.amount * factor;
  const rule = ROUNDING_RULES[quantity.unit];

  // The band is chosen from the scaled value, before rounding — so 96 g rounds in the
  // sub-100 band (to 100) rather than being pulled into the coarse band by its own
  // result.
  const rounded = roundToStep(scaled, rule.step(scaled));

  return { kind: "amount", amount: Math.max(rounded, rule.minimum), unit: quantity.unit };
}
