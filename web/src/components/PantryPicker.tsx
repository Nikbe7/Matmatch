import { Chip } from "./Chip";
import type { IngredientOption } from "../api";

/**
 * The full "Vad har du hemma?" picker — one treatment, two callers (#206).
 *
 * Before this, the same question had two renderings maintained by hand: the guided
 * flow's step-3 grid and Tonight's "Fler" sheet. They showed the *same list* and had
 * drifted apart anyway, which is the whole reason to have one component.
 *
 * No search box, on either surface. The list is server-capped at
 * `PANTRY_GRID_SIZE` (18, `src/api/guidedCatalog.ts`) and `src/api/app.test.ts`
 * asserts Tonight's and the guided flow's are byte-for-byte identical — so a filter
 * here could only narrow eighteen chips that are already all on screen. That buys a
 * keyboard, a query state and a no-match state in exchange for nothing, and on the
 * guided side it would also break UX_FLOW §5's "No text input anywhere else in this
 * flow". #206's acceptance criterion asked for search on the shared picker; it was
 * written on the belief that the sheet showed a longer list than the guided step,
 * and it does not.
 *
 * Tonight's six-chip row is deliberately *not* this component. That row is a teaser
 * on the zero-input screen and opens this picker via "Fler" — the point of #152 is
 * that the full picker is a layer you enter, not the default state of the main
 * screen.
 */
export function PantryPicker({
  options,
  selected,
  onToggle,
  label,
}: {
  options: readonly IngredientOption[];
  selected: readonly string[];
  onToggle: (ingredientId: string) => void;
  /** The grid's accessible name — the two callers word the surrounding screen
   *  differently, so the group label is theirs to give. */
  label: string;
}) {
  return (
    <div className="pantry-picker">
      <div role="group" aria-label={label} className="ingredient-grid">
        {options.map((option) => (
          <Chip
            key={option.id}
            className="ingredient-grid__item"
            pressed={selected.includes(option.id)}
            onClick={() => onToggle(option.id)}
          >
            {option.name}
          </Chip>
        ))}
      </div>
    </div>
  );
}
