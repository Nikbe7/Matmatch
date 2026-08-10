import { ALLERGIES } from "../../src/schema/vocabulary";
import type { IngredientAllergenMarking, TonightIngredient } from "./api";

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
   * The household-union allergen marking for this ingredient (#116). Stored
   * alongside the item, not re-derived on the client — the client holds no
   * household to derive it from — so it survives a reload with no connection,
   * which is when it matters most (UX_FLOW §7: usable offline).
   */
  allergens: IngredientAllergenMarking[];
}

export interface StoredShoppingList {
  version: 2;
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

// Bumped from 1: `ShoppingListItem` gained a required `allergens` field (#116). A
// list written before that field existed is discarded rather than merged — the
// version field's whole purpose (see the module comment) — because a missing
// marking must never render as "checked safe": the household would rather see a
// fresh, correctly-marked list than a stale one silently missing the field.
export const SHOPPING_LIST_VERSION = 2;
const STORAGE_KEY = "matmatch.shoppingList";

function isAllergenMarking(value: unknown): value is IngredientAllergenMarking {
  if (typeof value !== "object" || value === null) return false;
  const marking = value as Record<string, unknown>;
  return (
    typeof marking.allergy === "string" &&
    (ALLERGIES as readonly string[]).includes(marking.allergy) &&
    Array.isArray(marking.members) &&
    marking.members.every((member) => typeof member === "string")
  );
}

function isShoppingListItem(value: unknown): value is ShoppingListItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.name === "string" &&
    (item.section === "to_buy" || item.section === "have_at_home") &&
    typeof item.bought === "boolean" &&
    Array.isArray(item.allergens) &&
    item.allergens.every(isAllergenMarking)
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

export function saveShoppingList(list: StoredShoppingList): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function clearShoppingList(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Every ingredient starts in "Att köpa", unbought — except the ones the household
 * already told us it has.
 *
 * `inPantry` is set only by the guided flow (UX_FLOW §5 step 3 feeding step 5's
 * "✓ ris, ✓ grädde"); the Tonight card never asks the question, so its ingredients
 * carry no flag and every item starts in "Att köpa" exactly as before. Note what is
 * stored either way: item *names* for the dish the household accepted, never the
 * pantry selection itself — the ids are not persisted here or anywhere else.
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
      allergens: ingredient.allergens,
    })),
  };
}
