import type { DinerSelection } from "../engine/constraints.js";

// Parses `diners=0,2` — who is eating this meal, as member positions (#112,
// DECISION_LOG 2026-08-09). Session-scoped exactly like the weight vector and the
// pantry: read off the query string, used for one request, written nowhere. Nothing
// here touches the household profile, and deselecting someone for one evening must
// never look like editing who lives there.
//
// Unlike parseWeightsDeltaFromQuery and parseExcludeFromQuery, this module has no error
// path at all — no 400, no thrown HttpError, for any input. Every way of being
// malformed (an array-typed parameter from `?diners=0&diners=1`, a non-numeric token,
// a fractional or negative index, an index past the end of the roster, an empty
// value) resolves to `undefined`, which `mealDiners` reads as the whole household.
//
// That is a deliberate departure from the neighbouring parsers, on the grounds that
// this is the one parameter where the two idioms would conflict: rejecting some bad
// input and fail-closing on the rest means two rules on a safety-critical parameter,
// and the next edit picks the wrong one. One rule — anything that is not a complete,
// valid subset means everyone — cannot be applied half-way. A 400 would also be the
// worse outcome on its own merits: the safe answer is available and correct, and a
// client bug should not dead-end a household that did nothing wrong.
//
// Range validation is the *route's* job in the sense that it needs the roster, so it
// happens in `mealDiners` (src/engine/constraints.ts) rather than here — this module
// only turns a string into candidate indices.

/**
 * Candidate member indices, or `undefined` for "the whole household".
 *
 * `undefined` rather than an empty set on purpose: an empty set is a value a caller
 * could plausibly read as "nobody is eating", and there must be no in-band way to
 * express that. Both still resolve to everyone downstream — this just removes the
 * chance to misread one.
 */
export function parseDinersFromQuery(raw: unknown): DinerSelection | undefined {
  if (typeof raw !== "string") return undefined;

  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) return undefined;

  const indices = new Set<number>();
  for (const token of tokens) {
    // Plain decimal digits and nothing else, checked *before* converting. Neither
    // `Number` nor `parseInt` is a safe test on its own: `parseInt("1abc")` succeeds
    // on the prefix, and `Number` accepts several literal forms that are integers
    // without looking like indices — `"0x1"` is 1, `"1e2"` is 100, `"1_0"` is not but
    // near enough to make the rule hard to state. A member index has exactly one
    // spelling, so anything else is a client that did not mean this member.
    if (!/^\d+$/.test(token)) return undefined;

    const index = Number(token);
    // Beyond 2^53 the conversion stops being exact; such an index cannot name a real
    // member anyway, and letting it through would put an inexact number in the set.
    if (!Number.isSafeInteger(index)) return undefined;
    indices.add(index);
  }

  return indices;
}
