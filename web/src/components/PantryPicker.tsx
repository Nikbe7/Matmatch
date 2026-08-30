import { useState } from "react";
import { Chip } from "./Chip";
import { matchesIngredientQuery } from "../guided";
import type { IngredientOption } from "../api";

/**
 * The full "Vad har du hemma?" picker — one treatment, two callers (#206).
 *
 * Before this, the same question had three renderings: the guided flow's step-3 grid
 * (18 chips, flat, no search), Tonight's "Fler" sheet (the same list, also no search),
 * and step 2's *main ingredient* grid, which did have one. A household answering the
 * same question got a different control depending on which screen asked, and the
 * longest of the three lists was the one with no way to narrow it.
 *
 * The search box is opt-in, and only Tonight's sheet opts in. UX_FLOW §5 spells the
 * rule out for the guided flow — step 2's type-to-filter is "the one exception to
 * 'no text input'... No text input anywhere else in this flow" — and
 * `GuidedFlow.test.tsx` asserts it step by step. Tonight's "Fler" layer is not that
 * flow and is the surface #206 actually named: the longest list in the app, reached
 * deliberately, previously with no way to narrow it.
 *
 * So "one treatment" here means one component, one grid, one chip behaviour and one
 * definition of what the question is — not one affordance regardless of surface.
 *
 * Its state is internal rather than lifted: neither caller's state machine has an
 * opinion about a query it never persists, and the guided reducer already carries one
 * such field (`mainQuery`) it has to reset by hand on every transition. One is enough.
 *
 * Tonight's six-chip row is deliberately *not* this component. That row is a teaser on
 * the zero-input screen and opens this picker via "Fler" — the point of #152 is that
 * the full picker is a layer you enter, not the default state of the main screen.
 */
export function PantryPicker({
  options,
  selected,
  onToggle,
  label,
  searchable = false,
  autoFocus = false,
}: {
  options: readonly IngredientOption[];
  selected: readonly string[];
  onToggle: (ingredientId: string) => void;
  /** The grid's accessible name — the two callers word the surrounding screen
   *  differently, so the group label is theirs to give. */
  label: string;
  /** Renders the type-to-filter input. Off by default: see the note above on why the
   *  guided flow must not get one. */
  searchable?: boolean;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const trimmed = searchable ? query.trim() : "";
  const matching = trimmed
    ? options.filter((option) => matchesIngredientQuery(option.name, trimmed))
    : options;

  // Falls back to the whole list rather than an empty grid, matching step 2's
  // main-ingredient filter exactly (`mainGridOptions`): a typo should leave the
  // household looking at their options, not at nothing.
  const shown = matching.length > 0 ? matching : options;
  const noMatches = trimmed.length > 0 && matching.length === 0;

  return (
    <div className="pantry-picker">
      {searchable && (
        <input
          type="text"
          className="input pantry-picker__filter"
          placeholder="Skriv för att smalna av listan…"
          aria-label="Smalna av varorna"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus={autoFocus}
        />
      )}
      {noMatches && (
        <p className="muted" role="status">
          Ingen träff — visar alla varor.
        </p>
      )}
      <div role="group" aria-label={label} className="ingredient-grid">
        {shown.map((option) => (
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
