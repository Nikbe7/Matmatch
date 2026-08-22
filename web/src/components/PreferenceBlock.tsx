import { useId, useState } from "react";
import type { PreferenceWeights } from "../api";
import { SLIDER_AXES } from "../preferenceHints";
import { PreferenceSlider } from "./PreferenceSlider";

export const PREFERENCE_BLOCK_TITLE = "Vad är viktigt för er?";

/**
 * "Vad är viktigt för er?" (#159) — the same three sliders on both surfaces, editing
 * the same household baseline.
 *
 * One component, deliberately, and it holds no values of its own: both Tonight and the
 * profile pass the baseline in and get changes back out. Two copies of this block with
 * their own state is how the two screens would start disagreeing about what the
 * household asked for.
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
  weights,
  onChange,
  collapsible = false,
  disabled,
}: {
  weights: PreferenceWeights;
  onChange: (weights: PreferenceWeights) => void;
  collapsible?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(!collapsible);
  const panelId = useId();

  const sliders = (
    <div className="preference-block__sliders">
      {SLIDER_AXES.map((axis) => (
        <PreferenceSlider
          key={axis}
          axis={axis}
          value={weights[axis]}
          disabled={disabled}
          onChange={(value) => onChange({ ...weights, [axis]: value })}
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
