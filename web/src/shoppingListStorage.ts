import { QuantityUnitSchema } from "../../src/schema/recipeTemplate";
import type { ScaledQuantity, TonightIngredient } from "./api";

// localStorage read/write for the shopping list, kept behind one small typed
// module so the rest of the app never touches raw JSON. A version field means a
// future shape change can discard old stored data cleanly instead of crashing on
// it, and the parse is guarded so malformed/foreign JSON in the key resets to a
// fresh list rather than throwing.

export type ShoppingListSection = "to_buy" | "have_at_home";

export interface ShoppingListItem {
  name: string;
  section: ShoppingListSection;
  bought: boolean;
  /**
   * How much to buy, already scaled to tonight's diners by the server (#123).
   * Stored rather than re-derived: the client holds neither the template's authored
   * amounts nor the portion count, and the shop is exactly where the list gets
   * re-opened with no connection (UX_FLOW §7: usable offline).
   */
  quantity: ScaledQuantity;
  /**
   * Set when the household moved this row between sections itself (#202), and never
   * by the app placing it. `freshShoppingList` opens `inPantry` rows in "Har hemma",
   * and #200 moves rows there from Tonight's pantry chips — neither is work the
   * household would mind losing, because re-accepting the dish reproduces both. A
   * hand-move is the only one worth protecting, so it is the only one marked.
   *
   * Optional, so no SHOPPING_LIST_VERSION bump: a list stored before #202 simply has
   * the flag nowhere, which reads as "nothing was hand-moved" — true of every row it
   * can still say anything about.
   */
  movedByHand?: true;
  /** Which template slot this item fills, and the ingredient currently there (#124)
   * — identifies the tap target for the ingredient-swap popover. */
  slotIndex: number;
  ingredientId: string;
  /**
   * The variety note for this row (#223), carried into storage rather than re-fetched
   * so the sentence survives the reload the shop is full of — unlike `explanation`
   * and `portions`, which are genuinely not in hand on a resumed list, this one is
   * per-row curated text that was already here. A list stored before #223 simply has
   * no note on any row, which is the same as having nothing to say.
   */
  varietyNote?: string;
  /**
   * Present only immediately after a swap (#124) — the item's state right before
   * that swap, restored verbatim by one-tap undo. Cleared once undone; a second swap
   * overwrites it with the newer "before" state, so undo only ever reaches back one
   * step, never a whole history.
   */
  swappedFrom?: {
    name: string;
    ingredientId: string;
    bought: boolean;
    quantity: ScaledQuantity;
  };
}

export interface StoredShoppingList {
  version: 4;
  templateId: string;
  items: ShoppingListItem[];
  /**
   * Enough about the dish to re-open its list after a reload without a fetched
   * result to read it from — the guided flow's list belongs to a dish the Tonight
   * response knows nothing about, so without these a household that reloads in the
   * shop loses a half-checked list (UX_FLOW §7: the list persists across close and
   * reopen).
   *
   * Optional so a list written before this existed still parses instead of being
   * discarded as malformed.
   */
  templateName?: string;
  substitutions?: { slot_index: number; substitute_ingredient_id: string }[];
}

// Bumped from 3: `ShoppingListItem` gained required `slotIndex`/`ingredientId`
// fields (#124) — a tap has nothing to identify a slot with on an item written
// before they existed. Same discipline as the version-2 and -3 bumps this comment
// already describes: a required field existing partially across rows reads as
// broken, so the whole list is discarded rather than merged. `swappedFrom` is
// optional and not part of this bump — losing mid-swap undo state on an old list is
// not the same class of problem as a tap target that doesn't exist.
export const SHOPPING_LIST_VERSION = 4;
const STORAGE_KEY = "matmatch.shoppingList";

function isScaledQuantity(value: unknown): value is ScaledQuantity {
  if (typeof value !== "object" || value === null) return false;
  const quantity = value as Record<string, unknown>;
  if (quantity.kind === "to_taste") return true;
  return (
    quantity.kind === "amount" &&
    typeof quantity.amount === "number" &&
    Number.isFinite(quantity.amount) &&
    typeof quantity.unit === "string" &&
    (QuantityUnitSchema.options as readonly string[]).includes(quantity.unit)
  );
}

/**
 * Loosely validated: `swappedFrom` is recoverable undo state, not load-bearing data —
 * a malformed entry is dropped rather than discarding the whole stored list, the same
 * posture `templateName`/`substitutions` below already take on optional extras.
 */
function isSwappedFrom(value: unknown): value is NonNullable<ShoppingListItem["swappedFrom"]> {
  if (typeof value !== "object" || value === null) return false;
  const swapped = value as Record<string, unknown>;
  return (
    typeof swapped.name === "string" &&
    typeof swapped.ingredientId === "string" &&
    typeof swapped.bought === "boolean" &&
    isScaledQuantity(swapped.quantity)
  );
}

function isShoppingListItem(value: unknown): value is ShoppingListItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.name === "string" &&
    (item.section === "to_buy" || item.section === "have_at_home") &&
    typeof item.bought === "boolean" &&
    isScaledQuantity(item.quantity) &&
    typeof item.slotIndex === "number" &&
    Number.isInteger(item.slotIndex) &&
    item.slotIndex >= 0 &&
    typeof item.ingredientId === "string" &&
    (item.swappedFrom === undefined || isSwappedFrom(item.swappedFrom))
  );
}

function isStoredShoppingList(value: unknown): value is StoredShoppingList {
  if (typeof value !== "object" || value === null) return false;
  const stored = value as Record<string, unknown>;
  // templateName/substitutions are deliberately not validated: they are optional
  // display extras, and a list that has lost them is still a usable shopping list.
  return (
    stored.version === SHOPPING_LIST_VERSION &&
    typeof stored.templateId === "string" &&
    Array.isArray(stored.items) &&
    stored.items.every(isShoppingListItem)
  );
}

/**
 * The stored list, but only if it exists, parses, matches the current shape, and
 * belongs to `templateId` — a stored list for a different template is stale and
 * must be discarded rather than merged into the new one.
 */
export function loadShoppingList(templateId: string): StoredShoppingList | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isStoredShoppingList(parsed) || parsed.templateId !== templateId) return null;
  return parsed;
}

/**
 * The stored list regardless of which template it belongs to — used only for
 * the offline fallback (App.tsx's Gate), which has no fetched `TonightResult`
 * to check a template id against in the first place. `loadShoppingList`
 * above stays the one every other caller uses.
 */
export function loadAnyShoppingList(): StoredShoppingList | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return isStoredShoppingList(parsed) ? parsed : null;
}

/**
 * Where a list goes when a different dish takes its place (#202).
 *
 * Holds at most one list, overwritten by each displacement and cleared the moment the
 * offer to restore it retires. Deliberately a second key rather than a list of lists:
 * one dinner tonight is what a Matmatch shopping list *is*, and a slot that
 * accumulates would be the first half of week planning with none of the second
 * (aggregating quantities across dishes, removing one dish from a combined list). See
 * DECISION_LOG 2026-09-13.
 */
const DISPLACED_KEY = "matmatch.displacedShoppingList";

/**
 * Whether this list holds work the household did, as opposed to work the app did for
 * them — the test for whether losing it is worth an undo offer.
 *
 * Three things count, and all three are unambiguously a tap the household made:
 * ticking something off, moving a row between sections by hand, and applying an
 * ingredient swap. Everything else on a list is reproducible by accepting the dish
 * again, so a freshly generated, untouched list is losing nothing.
 */
export function hasHouseholdWork(list: StoredShoppingList): boolean {
  return list.items.some((item) => item.bought || item.movedByHand || item.swappedFrom);
}

/**
 * Stores a list, first setting aside any list it displaces that had work in it (#202).
 * Returns the list it displaced, or null.
 *
 * The displacement lives here rather than at the call site because every write goes
 * through this function, so no caller can forget it and no ordering between effects can
 * get it wrong. Saving over *the same* dish is not a displacement — that is the resume
 * path (#200: accept, reroll, accept again), and treating it as one would offer to
 * restore a list the household never lost.
 *
 * The return value is what the caller reports to analytics, and it is non-null exactly
 * once per displacement: every later save in that session carries the same template id
 * as the stored list and displaces nothing. That is what keeps `shopping_list_replaced`
 * from re-firing on each remount and quietly inflating the denominator of the restore
 * rate the event exists to measure.
 */
export function saveShoppingList(list: StoredShoppingList): StoredShoppingList | null {
  const displaced = loadAnyShoppingList();
  const displacing =
    displaced && displaced.templateId !== list.templateId && hasHouseholdWork(displaced)
      ? displaced
      : null;

  if (displacing) localStorage.setItem(DISPLACED_KEY, JSON.stringify(displacing));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  return displacing;
}

/** The displaced list still on offer, if there is one. */
export function loadDisplacedShoppingList(): StoredShoppingList | null {
  const raw = localStorage.getItem(DISPLACED_KEY);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return isStoredShoppingList(parsed) ? parsed : null;
}

/**
 * Retires the offer. Called on restore, on dismissal, once the household does work on
 * the list that replaced it — and by `clearShoppingList`, which is the household
 * abandoning this list context altogether ("Nytt förslag"), taking the offer attached
 * to it with them.
 */
export function clearDisplacedShoppingList(): void {
  localStorage.removeItem(DISPLACED_KEY);
}

/**
 * Puts a displaced list back as the current one and retires the offer.
 *
 * Written directly rather than through `saveShoppingList`, which would treat this as a
 * displacement of the list that replaced it. That is usually harmless — the replacing
 * list rarely has work yet, so the predicate above declines — but relying on that would
 * make restoring depend on the state of the thing it is undoing.
 */
export function restoreDisplacedShoppingList(list: StoredShoppingList): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  clearDisplacedShoppingList();
}

export function clearShoppingList(): void {
  localStorage.removeItem(STORAGE_KEY);
  clearDisplacedShoppingList();
}

/**
 * Every ingredient starts in "Att köpa", unbought — except the ones the household
 * already told us it has.
 *
 * `inPantry` here is set only by the guided flow's server response (UX_FLOW §5
 * step 3 feeding step 5's "✓ ris, ✓ grädde") — Tonight's ingredients carry no such
 * flag. Tonight's pantry-row selection is applied separately and later, by
 * `ShoppingList` itself (#200): on top of whichever list this function or a
 * resumed `stored` list produced, never baked into the ingredients beforehand, so
 * a second accept of the same dish still picks up a pantry tap made after the
 * first one was already stored. An ingredient with no flag either way starts in
 * "Att köpa" exactly as before. `slotIndex` and `ingredientId` are stored too, as
 * of #124 — never the pantry selection itself, which stays unpersisted as before,
 * but the ingredient-swap popover needs an identifier for its tap target to
 * survive a reload.
 */
export function freshShoppingList(
  templateId: string,
  ingredients: readonly (TonightIngredient & { inPantry?: boolean })[],
): StoredShoppingList {
  return {
    version: SHOPPING_LIST_VERSION,
    templateId,
    items: ingredients.map((ingredient) => ({
      name: ingredient.name,
      section: ingredient.inPantry ? "have_at_home" : "to_buy",
      bought: false,
      quantity: ingredient.quantity,
      slotIndex: ingredient.slotIndex,
      ingredientId: ingredient.ingredientId,
      ...(ingredient.varietyNote === undefined ? {} : { varietyNote: ingredient.varietyNote }),
    })),
  };
}
