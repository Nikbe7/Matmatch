import type { Allergy } from "../../src/schema/allergyDietary";

/**
 * The noun step 2's allergy-excluded explanation names ("Lax är utesluten på
 * grund av fiskallergi") — a separate map from `App.tsx`'s `ALLERGY_LABELS`
 * ("Fisk") because the two read differently mid-sentence: a chip label is a noun
 * on its own, this is the first half of a compound word.
 */
export const ALLERGY_ALLERGI_LABELS: Record<Allergy, string> = {
  gluten: "glutenallergi",
  dairy_lactose: "laktosallergi",
  egg: "äggallergi",
  tree_nuts: "trädnötsallergi",
  peanuts: "jordnötsallergi",
  shellfish: "skaldjursallergi",
  fish: "fiskallergi",
  soy: "sojaallergi",
};

/** "a, b och c" — Swedish list conjunction, matching the server's `joinSwedish`. */
function joinSwedish(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} och ${parts[parts.length - 1]}`;
}

/** The reason clause for a catalog ingredient excluded by one or more allergies. */
export function allergyExclusionReason(allergies: readonly Allergy[]): string {
  return joinSwedish(allergies.map((allergy) => ALLERGY_ALLERGI_LABELS[allergy]));
}

/**
 * The noun the shopping list's "innehåller X" marking names (#116) — lowercase,
 * mid-sentence, distinct from `App.tsx`'s `ALLERGY_LABELS` (title-case chip labels)
 * for the same reason `ALLERGY_ALLERGI_LABELS` above is: the two read differently
 * mid-sentence.
 */
export const ALLERGEN_CONTAINS_LABELS: Record<Allergy, string> = {
  gluten: "gluten",
  dairy_lactose: "mjölk",
  egg: "ägg",
  tree_nuts: "trädnötter",
  peanuts: "jordnötter",
  shellfish: "skaldjur",
  fish: "fisk",
  soy: "soja",
};

/**
 * "innehåller mjölk — Elsa" / "innehåller mjölk och ägg — Elsa och Sam" — the
 * shopping list's per-ingredient allergen marking. Members are named because the
 * marking answers "who must not eat this," not just "what does this contain."
 */
export function allergenMarkingText(allergy: Allergy, members: readonly string[]): string {
  const noun = ALLERGEN_CONTAINS_LABELS[allergy];
  return members.length > 0 ? `innehåller ${noun} — ${joinSwedish(members)}` : `innehåller ${noun}`;
}

/**
 * Catalog ingredient names are stored lowercase (`data/ingredients.json`), which is
 * right for a tap-grid label but wrong at the start of a sentence. Display-only —
 * it does not touch the name anywhere it is compared or sent to the API.
 */
export function capitalizeForSentence(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
}
