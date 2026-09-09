// Split out of guidedCatalog.ts (#235) so the frontend can import this constant
// without pulling that module's whole graph — down to engine/data.ts's Node-only
// `fs`/`url` imports — into web's `tsc -b` program. Zero other imports, on purpose:
// anything added here must stay safe for both runtimes, the same rule
// engine/quantities.ts already follows for MIN_PORTIONS/MAX_PORTIONS.

/**
 * How many *tiles* each grid shows. Sized for a 360px screen at three columns —
 * four rows of proteins, six of pantry staples — and for the tap-first principle:
 * a grid long enough to need scrolling is a list, and a list is one step from the
 * search box UX_FLOW §5 explicitly rules out.
 *
 * `MAIN_INGREDIENT_GRID_SIZE` is a display constant only (#235) — it does not bound
 * `buildMainIngredientOptions`'s result. UX_FLOW §5's type-to-filter is meant to
 * reach the household's whole eligible set, not just the ~12 tiles on screen, so the
 * client fetches the full deduped list and slices to this size itself for the
 * no-query grid. `PANTRY_GRID_SIZE` still bounds `buildPantryIngredientOptions`
 * directly — step 3 has no search exception to feed.
 */
export const MAIN_INGREDIENT_GRID_SIZE = 12;
export const PANTRY_GRID_SIZE = 18;
