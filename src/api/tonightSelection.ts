import { HttpError } from "./httpError.js";

// Parses the per-request "what have I already seen" state for /api/tonight's
// adjustment-chip flow (DECISION_LOG 2026-08-05, the chip-driven refinement
// entry). Two different kinds of bad input, treated differently on purpose:
//
// - A *wrong-typed* parameter (`?exclude=a&exclude=b`, which Express hands over as
//   an array, or a bracketed object) is a client bug. It is rejected with a 400 and
//   a structured code, the same way parseWeightsDeltaFromQuery rejects a malformed
//   weight — silently coercing it would hide the bug and quietly show the household
//   a dish it has already rejected.
// - An *unknown or stale* template id is not a bug: a household whose constraints
//   changed mid-session legitimately holds ids nothing in the candidate set matches
//   any more. Those are ignored downstream rather than rejected here.

// Matches ShoppingList's cap of "everything shown so far" at a size that can never
// grow unbounded within a single session — 30 is comfortably above the real
// candidate set a household would page through in one sitting. Over-long lists are
// truncated rather than rejected: the extra ids are always ids the client already
// knows are not coming back, so dropping them costs nothing, while a 400 would
// dead-end a session that did nothing wrong.
const MAX_EXCLUDED_IDS = 30;

function requireStringParam(name: "exclude" | "previous" | "keep", raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new HttpError(400, `invalid_${name}`, `${name} must be a single string value`);
  }
  return raw;
}

export function parseExcludeFromQuery(raw: unknown): ReadonlySet<string> {
  const value = requireStringParam("exclude", raw);
  if (value === undefined || value.length === 0) return new Set();

  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  return new Set(ids.slice(0, MAX_EXCLUDED_IDS));
}

export function parsePreviousFromQuery(raw: unknown): string | undefined {
  const value = requireStringParam("previous", raw);
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * The template id a diner-set change is trying to keep (#133) — distinct from
 * `previous`, which only ever *steers away from* a dish (the reroll-diversity
 * hint `pickNextSuggestion` reads). `keep` means "this exact dish was already on
 * screen; return it again if the new diner set still allows it, and only pick a
 * replacement if it does not." The two are never sent together by the client.
 */
export function parseKeepFromQuery(raw: unknown): string | undefined {
  const value = requireStringParam("keep", raw);
  return value !== undefined && value.length > 0 ? value : undefined;
}
