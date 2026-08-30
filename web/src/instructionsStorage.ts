import { QuantityUnitSchema, type PrepTimeBand } from "../../src/schema/recipeTemplate";
import type { ScaledQuantity, TonightSubstitution } from "./api";

// Everything the cook screen needs to work with no connection, written once the
// instructions have been fetched successfully (#154).
//
// This exists because the service worker deliberately never caches `/api/*`
// (sw.ts) — an authenticated response in a shared cache is stale data at best and
// cross-account leakage at worst. So offline support for a screen backed by an API
// call has to be an explicit, typed record the app writes itself, exactly as the
// shopping list already does.
//
// The record is self-contained on purpose: name, curated prep-time band, ingredient
// amounts *and* steps. A household that opens the cook screen in a kitchen with no
// signal must not depend on a shopping list still being in storage, or on the
// Tonight response that produced it being re-fetchable.

/** Cache key, byte-identical to the server's (`buildSubstitutionKey`) so the two
 *  never disagree about what "the same dish" means. Portions are deliberately absent
 *  — scaling is deterministic and applied at render time. */
export function substitutionKey(substitutions: readonly TonightSubstitution[]): string {
  return [...substitutions]
    .sort((a, b) => a.slot_index - b.slot_index)
    .map((substitution) => `${substitution.slot_index}:${substitution.substitute_ingredient_id}`)
    .join(",");
}

export interface CookIngredient {
  name: string;
  quantity: ScaledQuantity;
  /** The variety note for this row (#223) — see `ShoppingListItem.varietyNote`. The
   *  stove is where the difference actually bites, so it is carried here too. */
  varietyNote?: string;
}

export interface CookRecord {
  version: 1;
  templateId: string;
  /** The substitution set these steps were generated for. Two swaps of the same
   *  dish are two records, matching the server's cache. */
  substitutionKey: string;
  /** The same set unreduced, so a cold open of `/laga/:id` can rebuild the dish
   *  without a shopping list in storage to read it from — the key alone is a
   *  one-way reduction and parsing it back would be a second, silently divergent
   *  implementation of the same format. */
  substitutions: TonightSubstitution[];
  name: string;
  /**
   * Curated (`RecipeTemplate.prep_time_band`), never derived from the steps. The
   * cook screen's time is a planning number and planning numbers come from curated
   * data — see DECISION_LOG. Optional only because a list resumed from an older
   * session may not carry it; the row is then omitted rather than guessed.
   */
  prepTimeBand?: PrepTimeBand;
  portions?: number;
  ingredients: CookIngredient[];
  steps: string[];
}

const STORAGE_KEY = "matmatch.cookInstructions";
export const COOK_RECORD_VERSION = 1;

/** How many dishes' instructions to keep. Small on purpose: this is an offline
 *  safety net for the dish being cooked, not a recipe archive, and localStorage is
 *  a shared, small budget the shopping list also lives in. */
const MAX_RECORDS = 5;

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

function isSubstitution(value: unknown): value is TonightSubstitution {
  if (typeof value !== "object" || value === null) return false;
  const substitution = value as Record<string, unknown>;
  return (
    typeof substitution.slot_index === "number" &&
    Number.isInteger(substitution.slot_index) &&
    typeof substitution.substitute_ingredient_id === "string"
  );
}

function isCookIngredient(value: unknown): value is CookIngredient {
  if (typeof value !== "object" || value === null) return false;
  const ingredient = value as Record<string, unknown>;
  return typeof ingredient.name === "string" && isScaledQuantity(ingredient.quantity);
}

function isCookRecord(value: unknown): value is CookRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === COOK_RECORD_VERSION &&
    typeof record.templateId === "string" &&
    typeof record.substitutionKey === "string" &&
    Array.isArray(record.substitutions) &&
    record.substitutions.every(isSubstitution) &&
    typeof record.name === "string" &&
    Array.isArray(record.ingredients) &&
    record.ingredients.every(isCookIngredient) &&
    Array.isArray(record.steps) &&
    record.steps.every((step) => typeof step === "string")
  );
}

function readAll(): CookRecord[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  // Per-record validation rather than all-or-nothing: one malformed entry from an
  // older shape should cost that dish's offline copy, not every dish's.
  return Array.isArray(parsed) ? parsed.filter(isCookRecord) : [];
}

/** The stored steps for exactly this dish and substitution set, or null. A record
 *  for a different substitution set is not a partial match — it is a different
 *  recipe — so it is never returned as a fallback. */
export function loadCookRecord(
  templateId: string,
  substitutions: readonly TonightSubstitution[],
): CookRecord | null {
  const key = substitutionKey(substitutions);
  return (
    readAll().find((record) => record.templateId === templateId && record.substitutionKey === key) ??
    null
  );
}

/** Writes (or replaces) one dish's record, most recent first, evicting the oldest
 *  beyond `MAX_RECORDS`. Storage failures are swallowed: a full or disabled
 *  localStorage must degrade offline support, never break cooking. */
export function saveCookRecord(record: CookRecord): void {
  const others = readAll().filter(
    (existing) =>
      existing.templateId !== record.templateId ||
      existing.substitutionKey !== record.substitutionKey,
  );

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([record, ...others].slice(0, MAX_RECORDS)));
  } catch {
    // Intentionally empty — see above.
  }
}

/**
 * The most recently written record for a template, whatever substitution set it was
 * generated for — the resume path for `/laga/:id` opened cold (a reload, a
 * bookmark, an offline start), where nothing in hand names the substitutions yet.
 *
 * Deliberately not used for the cache lookup itself: `loadCookRecord` above stays
 * exact, because serving one swap's steps for another swap's dish would be showing
 * the wrong recipe. Here the record *is* the dish being resumed, substitutions
 * included, so there is nothing to mismatch against.
 */
export function loadLatestCookRecord(templateId: string): CookRecord | null {
  return readAll().find((record) => record.templateId === templateId) ?? null;
}

export function clearCookRecords(): void {
  localStorage.removeItem(STORAGE_KEY);
}
