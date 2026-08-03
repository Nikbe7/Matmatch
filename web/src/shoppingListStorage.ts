import type { TonightIngredient } from "./api";

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
}

export interface StoredShoppingList {
  version: 1;
  templateId: string;
  items: ShoppingListItem[];
}

const CURRENT_VERSION = 1;
const STORAGE_KEY = "matmatch.shoppingList";

function isShoppingListItem(value: unknown): value is ShoppingListItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.name === "string" &&
    (item.section === "to_buy" || item.section === "have_at_home") &&
    typeof item.bought === "boolean"
  );
}

function isStoredShoppingList(value: unknown): value is StoredShoppingList {
  if (typeof value !== "object" || value === null) return false;
  const stored = value as Record<string, unknown>;
  return (
    stored.version === CURRENT_VERSION &&
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

export function saveShoppingList(list: StoredShoppingList): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function clearShoppingList(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Every ingredient starts in "Att köpa", unbought. */
export function freshShoppingList(
  templateId: string,
  ingredients: readonly TonightIngredient[],
): StoredShoppingList {
  return {
    version: CURRENT_VERSION,
    templateId,
    items: ingredients.map((ingredient) => ({
      name: ingredient.name,
      section: "to_buy",
      bought: false,
    })),
  };
}
