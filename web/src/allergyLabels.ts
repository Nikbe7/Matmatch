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
 * Catalog ingredient names are stored lowercase (`data/ingredients.json`), which is
 * right for a tap-grid label but wrong at the start of a sentence. Display-only —
 * it does not touch the name anywhere it is compared or sent to the API.
 */
export function capitalizeForSentence(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
}
