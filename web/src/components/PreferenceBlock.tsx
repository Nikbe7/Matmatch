import { useEffect, useId, useState } from "react";
import type { PreferenceWeights } from "../api";
import { SLIDER_AXES } from "../preferenceHints";
import { PreferenceSlider } from "./PreferenceSlider";

export const PREFERENCE_BLOCK_TITLE = "Vad är viktigt för er?";

/**
 * "Vad är viktigt för er?" (#159) — the same three sliders on both surfaces, editing
 * the same household baseline.
 *
 * `settled`/`onCommit` are the household's actual baseline: both Tonight and the
 * profile pass it in and get a new committed value back out, so the two screens
 * can never disagree about what was asked for. The live, per-notch value while a
 * thumb is moving is a *different* piece of state, owned locally right here rather
 * than lifted to whichever screen renders this block (2026-08-23) — it used to live
 * in `Gate`, the component owning the whole fetched Tonight response and routed
 * shell, so every notch of a drag re-rendered the entire screen under the sliders
 * for a value nothing outside this component reads live. That was the actual cause
 * of "the slider isn't smooth" once the settle-timer and touch-action fixes on
 * their own still weren't enough.
 *
 * `collapsible` is the only difference between the surfaces. On Tonight the block is
 * collapsed and shows nothing but its heading, so a household that never scrolls past
 * "Laga ikväll" never learns it exists — Tonight is the zero-input screen, and a
 * control panel under the suggestion is still a control panel. On the profile, where
 * the household came specifically to adjust things, it renders open.
 *
 * Four sliders since #153, all in the same register: `simplicity` renders exactly
 * like the other three, with no marking that it is the newest one.
 */
export function PreferenceBlock({
  settled,
  onCommit,
  collapsible = false,
  disabled,
}: {
  settled: PreferenceWeights;
  onCommit: (weights: PreferenceWeights) => void;
  collapsible?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(!collapsible);
  const panelId = useId();

  // Seeded from the real baseline and re-synced whenever it changes from outside
  // (the first load landing, or a commit made on the *other* screen before this one
  // mounted) — but every notch in between updates only this local state, never the
  // parent, which is the whole point.
  const [live, setLive] = useState(settled);
  useEffect(() => setLive(settled), [settled]);

  const sliders = (
    <div className="preference-block__sliders">
      {SLIDER_AXES.map((axis) => (
        <PreferenceSlider
          key={axis}
          axis={axis}
          value={live[axis]}
          disabled={disabled}
          onChange={(value) => setLive((current) => ({ ...current, [axis]: value }))}
          onCommit={(value) => {
            const next = { ...live, [axis]: value };
            setLive(next);
            onCommit(next);
          }}
        />
      ))}
    </div>
  );

  if (!collapsible) {
    return (
      <section className="preference-block preference-block--open">
        <h2 className="preference-block__title">{PREFERENCE_BLOCK_TITLE}</h2>
        {sliders}
      </section>
    );
  }

  return (
    <section className="preference-block">
      <button
        type="button"
        className="preference-block__toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="preference-block__title">{PREFERENCE_BLOCK_TITLE}</span>
        <span aria-hidden="true" className={`preference-block__chevron${open ? " is-open" : ""}`}>
          ⌄
        </span>
      </button>
      {/* Unmounted rather than hidden while collapsed: the sliders are a real editing
          surface, and leaving three focusable controls in the tab order behind a
          closed heading is a trap for anyone not using a pointer. */}
      {open && <div id={panelId}>{sliders}</div>}
    </section>
  );
}
