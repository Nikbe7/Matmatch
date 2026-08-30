import { useState } from "react";
import { Chip } from "./components/Chip";
import {
  dinersParameter,
  everyone,
  rosterFingerprint,
  toggleDiner,
  type DinerLabel,
  type DinerSelection,
} from "./diners";

// The diner picker (#112, DECISION_LOG 2026-08-09), shared by the Tonight card and
// the guided flow.
//
// Its own module on purpose: it belongs to neither `refinementReducer` nor
// `guidedReducer`. Both surfaces need the same control and the same selection rules,
// and a copy in each reducer is exactly how two surfaces end up disagreeing about who
// is eating — the disagreement this whole slice exists to remove one level down.
//
// It is a refinement, never a gate (condition 2): both surfaces show a suggestion
// first, with every member selected, and this control adjusts what is already there.

/**
 * The selection plus everything a caller needs to use it. `parameter` is what goes on
 * the wire — `undefined` when everyone is eating, so an untouched session sends no
 * diner parameter at all.
 */
export interface DinerSelectionState {
  labels: readonly DinerLabel[];
  selection: DinerSelection;
  parameter: string | undefined;
  toggle: (index: number) => void;
  /**
   * Put the selection back to a previous value, for a caller whose request failed.
   * The picker must never show a diner set that no suggestion on screen was built
   * for — an unreachable selection is worse than an undone tap.
   */
  restore: (selection: DinerSelection) => void;
}

/**
 * Session state for the diner set, seeded to everyone and reset to everyone whenever
 * the roster changes underneath it.
 *
 * The reset is the mitigation for positional identity: a member is its index, so a
 * selection made against one roster is meaningless against another — index 1 may now
 * be a different person. Rather than leave that for whoever builds member editing,
 * the selection is discarded the moment the labels change, which fails closed (back
 * to everyone) instead of silently applying somebody else's dietary flags. The server
 * range-check catches the out-of-range half of the same problem; this catches the
 * half that stays in range.
 *
 * Nothing here is persisted: no localStorage, no URL, no household write. A reload
 * starts from everyone, which is the safe state.
 */
export function useDinerSelection(labels: readonly DinerLabel[] | undefined): DinerSelectionState {
  interface Settled {
    fingerprint: string;
    roster: readonly DinerLabel[];
    selection: DinerSelection;
  }

  const [state, setState] = useState<Settled>(() => ({
    fingerprint: rosterFingerprint(labels),
    roster: labels ?? [],
    selection: everyone((labels ?? []).length),
  }));

  // `undefined` is "not loaded yet", not "the household changed" — the window before
  // the first response, and during a refetch, must not throw the selection away or a
  // toggle would undo itself on the request it just triggered.
  const changed = labels !== undefined && rosterFingerprint(labels) !== state.fingerprint;
  const settled: Settled = changed
    ? { fingerprint: rosterFingerprint(labels), roster: labels, selection: everyone(labels.length) }
    : state;

  // Adjusting state during render rather than in an effect: React's documented
  // pattern for state derived from changed props, and it matters here that no render
  // ever goes out with a selection belonging to a roster that no longer exists.
  if (changed) setState(settled);

  return {
    labels: settled.roster,
    selection: settled.selection,
    parameter: dinersParameter(settled.selection, settled.roster.length),
    toggle: (index: number) =>
      setState((current) => ({ ...current, selection: toggleDiner(current.selection, index) })),
    restore: (previous: DinerSelection) =>
      setState((current) => ({ ...current, selection: previous })),
  };
}

/**
 * One tap per member, everyone selected to begin with.
 *
 * Renders nothing for a one-member household: there is no selection to make, and a
 * control whose only state is its default is noise.
 */
export function DinerPicker({
  state,
  busy = false,
}: {
  state: DinerSelectionState;
  busy?: boolean;
}) {
  if (state.labels.length < 2) return null;

  return (
    <section className="diner-picker" aria-labelledby="diner-picker-title">
      <h3 id="diner-picker-title" className="diner-picker__title">
        Vilka äter?
      </h3>
      <div role="group" aria-labelledby="diner-picker-title" className="diner-picker__options">
        {state.labels.map((diner, index) => {
          const selected = state.selection.has(index);
          // The last remaining diner cannot be deselected — disabled rather than
          // silently ignored, so the rule is visible instead of feeling broken.
          const isLastSelected = selected && state.selection.size === 1;

          return (
            <Chip
              key={`${diner.label}-${index}`}
              pressed={selected}
              disabled={busy || isLastSelected}
              onClick={() => state.toggle(index)}
            >
              {diner.label}
            </Chip>
          );
        })}
      </div>
      {/*
        The cross-contamination honesty line that stood here is gone with allergy
        filtering (#224). It warned that leftovers and shared pans still carry an
        allergen the diner set cannot account for — true, but it is the app's only
        remaining mention of allergens, on a screen that now scopes nothing but
        dietary flags and portions. Naming a hazard the product otherwise says
        nothing about reads as a residual promise, which is the thing #224 removed.
      */}
    </section>
  );
}
