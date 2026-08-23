import { useEffect, useRef } from "react";
import {
  AXIS_COPY,
  PREFERENCE_MAX,
  PREFERENCE_MIN,
  PREFERENCE_STEP,
  bandFor,
  sliderAccessibleName,
  type SliderAxis,
} from "../preferenceHints";

/**
 * One preference axis (#158): label, the control, and a sentence saying what the app
 * will actually do at that level.
 *
 * A plain `<input type="range">`, not a new UI primitive — the reference reaches for a
 * Radix slider, and pulling in a component library to render one control would be a
 * dependency taken for styling. Range inputs already give keyboard support (arrows step
 * by `step`, Home/End jump to the ends), focus handling and the right ARIA role for
 * free; what they do not give is a thumb big enough for a thumb, which is what the CSS
 * beside this file supplies (44px target, per lovable-reference/README.md's rule).
 *
 * The wording is not this component's business — it comes from `preferenceHints.ts`,
 * which is where the behavioural thresholds are stated and tested. A component that
 * chose its own phrasing per value is exactly how a hint starts promising something the
 * engine does not do.
 *
 * No value label beside the axis name (removed post-#161 review). `HintBand.level`
 * ("Spelar ingen roll" etc.) describes how much the household has dialled an axis up,
 * which is a different claim from what the hint sentence below it says the engine
 * actually does at that notch — and at 0 the two disagree on variation and simplicity:
 * 0 is defined (#157) to reproduce yesterday's behaviour, not "this axis has no
 * effect", so "Spelar ingen roll" sits next to "Vi håller oss till sådant ni känner
 * igen" claiming the opposite of what the hint just said. Two summaries of the same
 * value where one is wrong is worse than one — the hint is the single source of truth
 * for what a notch means, so it is the only one shown, and the only one announced.
 */
export function PreferenceSlider({
  axis,
  value,
  onChange,
  onCommit,
  disabled,
}: {
  axis: SliderAxis;
  value: number;
  /** Every notch — keeps the thumb and the hint sentence responsive while dragging. */
  onChange: (value: number) => void;
  /**
   * The value once the household lets go — never mid-drag. Wired to the input's
   * native `change` event (via `ref`, below) rather than a settle timer: `change`
   * only fires on release for a pointer drag, and once per press for the keyboard,
   * which is exactly "commit" in both cases with no risk of firing while a thumb is
   * still down (#159 follow-up — a settle timer could fire mid-drag if the thumb
   * paused between notches, re-ranking and resizing the suggestion card under it).
   */
  onCommit: (value: number) => void;
  disabled?: boolean;
}) {
  const { label } = AXIS_COPY[axis];
  const band = bandFor(axis, value);
  const hintId = `preference-hint-${axis}`;
  const inputRef = useRef<HTMLInputElement>(null);

  // React's `onChange` prop is wired to the DOM `input` event (fires continuously
  // while dragging) with no built-in way to also hear the native `change` event
  // (fires once, on release) — so `onCommit` is attached directly.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const handleCommit = () => onCommit(Number(input.value));
    input.addEventListener("change", handleCommit);
    return () => input.removeEventListener("change", handleCommit);
  }, [onCommit]);

  return (
    <div className="preference-slider">
      <div className="preference-slider__head">
        <span className="preference-slider__label">{label}</span>
      </div>
      <input
        ref={inputRef}
        type="range"
        className="preference-slider__control"
        min={PREFERENCE_MIN}
        max={PREFERENCE_MAX}
        step={PREFERENCE_STEP}
        value={value}
        disabled={disabled}
        // The hint sentence, not the raw notch: a screen reader should hear what the
        // household reads. `aria-valuetext` overrides the number the range input would
        // otherwise announce, which on its own means nothing to anybody — and it is the
        // same sentence rendered below, never a separate summary that could disagree
        // with it.
        aria-label={sliderAccessibleName(axis)}
        aria-valuetext={band.hint}
        aria-describedby={hintId}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <p id={hintId} className="preference-slider__hint">
        {band.hint}
      </p>
    </div>
  );
}
