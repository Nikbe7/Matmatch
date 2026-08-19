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
 * One preference axis (#158): label, the level in words, the control, and a sentence
 * saying what the app will actually do at that level.
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
 */
export function PreferenceSlider({
  axis,
  value,
  onChange,
  disabled,
}: {
  axis: SliderAxis;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const { label } = AXIS_COPY[axis];
  const band = bandFor(axis, value);
  const hintId = `preference-hint-${axis}`;

  return (
    <div className="preference-slider">
      <div className="preference-slider__head">
        <span className="preference-slider__label">{label}</span>
        <span className="preference-slider__level">{band.level}</span>
      </div>
      <input
        type="range"
        className="preference-slider__control"
        min={PREFERENCE_MIN}
        max={PREFERENCE_MAX}
        step={PREFERENCE_STEP}
        value={value}
        disabled={disabled}
        // The level in words, not the raw notch: a screen reader should hear what the
        // household reads. `aria-valuetext` overrides the number the range input would
        // otherwise announce, which on its own means nothing to anybody.
        aria-label={sliderAccessibleName(axis, value)}
        aria-valuetext={band.level}
        aria-describedby={hintId}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <p id={hintId} className="preference-slider__hint">
        {band.hint}
      </p>
    </div>
  );
}
