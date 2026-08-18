import {
  PREFERENCE_AXES,
  PREFERENCE_WEIGHT_MAX,
  PREFERENCE_WEIGHT_MIN,
  PREFERENCE_WEIGHT_STEP,
  type PreferenceAxis,
  type PreferenceWeightsDelta,
} from "../schema/preferenceWeights.js";
import { HttpError } from "./httpError.js";

// Parses the session-scoped preference delta from query parameters (DECISION_LOG
// 2026-07-31 as amended by 2026-08-16, issue #157).
//
// What this returns is a *delta*, not a weight vector: the household's persistent
// baseline lives in the database, and the route combines the two with
// `combinePreferenceWeights` before ranking. A query parameter is the per-request form
// of "session-scoped, chip-driven, never persisted" — nothing here writes anything, so
// it does not turn the chips into a second settings surface.
//
// Units are slider notches (0–100, step 5), the same units the baseline is stored in,
// because there is one axis definition and both halves speak it. Before #157 these
// parameters carried raw engine weights (`?cost=1`), which meant a chip and a slider
// expressed the same preference on two different scales — the parallel-mechanics trap
// this issue exists to close. `cost` is gone as a parameter name; the axis is `price`
// everywhere now, and nothing is deployed that could still be sending the old spelling
// (DECISION_LOG 2026-08-07).
//
// An absent parameter means "this chip was not tapped", which
// `combinePreferenceWeights` reads as 0 — identical to sending it explicitly as 0, so
// the client is free to omit its defaults.

function parseAxis(name: PreferenceAxis, raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new HttpError(400, "invalid_weights", `${name} must be a single numeric value`);
  }

  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < PREFERENCE_WEIGHT_MIN ||
    value > PREFERENCE_WEIGHT_MAX ||
    value % PREFERENCE_WEIGHT_STEP !== 0
  ) {
    throw new HttpError(
      400,
      "invalid_weights",
      `${name} must be an integer between ${PREFERENCE_WEIGHT_MIN} and ${PREFERENCE_WEIGHT_MAX}, in steps of ${PREFERENCE_WEIGHT_STEP}`,
    );
  }

  return value;
}

/**
 * The session delta the client asked for, with absent axes left absent.
 *
 * Deliberately does not fill in zeros: an omitted axis and a zero axis are the same
 * thing to `combinePreferenceWeights`, and leaving it absent keeps this function from
 * having a second opinion about what the default is. The default lives in exactly one
 * place — `NEUTRAL_PREFERENCE_WEIGHTS`, which is also what the migration backfills.
 */
export function parseWeightsDeltaFromQuery(query: Record<string, unknown>): PreferenceWeightsDelta {
  const delta: PreferenceWeightsDelta = {};

  for (const axis of PREFERENCE_AXES) {
    const value = parseAxis(axis, query[axis]);
    if (value !== undefined) delta[axis] = value;
  }

  return delta;
}
