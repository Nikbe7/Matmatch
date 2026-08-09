// Who is eating this meal (#112, DECISION_LOG 2026-08-09). Pure logic only — the
// picker component and its hook live in DinerPicker.tsx, which imports this.
//
// Session-scoped like the weight vector and the pantry, and for the same reason:
// there is deliberately no load/save pair here the way shoppingListStorage.ts has
// one. Deselecting someone for one evening is not an edit to who lives in the
// household, and nothing in this module or its callers writes either one.
//
// This module holds no state and belongs to neither reducer. Both surfaces (the
// Tonight card and the guided flow) drive the same functions, so neither can grow
// its own idea of what a diner set is.

/** A member as the client knows them: a display label at a position. Nothing else. */
export interface DinerLabel {
  label: string;
}

/** The selection, as member positions. Empty is not a reachable state — see `toggleDiner`. */
export type DinerSelection = ReadonlySet<number>;

/** Everyone eating: the default, and what any surface starts from. */
export function everyone(count: number): DinerSelection {
  return new Set(Array.from({ length: count }, (_, index) => index));
}

/**
 * Toggling the last remaining diner is a no-op, returning the same set.
 *
 * A UI-side rule, not the safety mechanism: the server reads an empty selection as
 * the whole household, so the two agree that "nobody" is not an answer. What this
 * prevents is the confusing screen in between — a picker showing zero diners while
 * the suggestion behind it is constrained by all of them.
 */
export function toggleDiner(selection: DinerSelection, index: number): DinerSelection {
  if (!selection.has(index)) return new Set([...selection, index]);
  if (selection.size === 1) return selection;

  const next = new Set(selection);
  next.delete(index);
  return next;
}

/**
 * The `diners` query parameter, or `undefined` when everyone is eating.
 *
 * Omitted at the default rather than spelled out, matching how `fetchTonight` omits
 * an untouched weight vector: an untouched session sends no diner parameter at all,
 * so the server's own fail-closed default is what answers, not a client restatement
 * of it. Sorted so the same set of people always produces the same URL.
 */
export function dinersParameter(selection: DinerSelection, count: number): string | undefined {
  if (count === 0 || selection.size >= count) return undefined;
  return [...selection].sort((a, b) => a - b).join(",");
}

/**
 * A roster identity a selection can be checked against.
 *
 * A member *is* its index (DECISION_LOG 2026-08-09), so a selection only means
 * anything against the roster it was made on: if the household changes underneath a
 * session, index 1 may now be a different person, and the selection has to be
 * discarded rather than reinterpreted. The labels are the only view of the roster
 * this client has, and they change whenever a member is added, removed, reordered or
 * renamed — which is exactly the set of edits that can invalidate a position.
 */
export function rosterFingerprint(labels: readonly DinerLabel[] | undefined): string {
  return labels ? JSON.stringify(labels.map((diner) => diner.label)) : "";
}
