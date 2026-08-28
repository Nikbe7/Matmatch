// ARCHITECTURE.md §5.2 — dietary vocabulary (and the allergy value list), locked
// values only.
//
// Zod-free, but no longer for the reason this file was split out. That reason was
// the frontend importing the list directly for its onboarding allergy chips without
// pulling zod in; those chips are gone (#224) and web/ does not import this module at
// all any more — and it already imports `QuantityUnitSchema` from a zod module
// elsewhere, so the constraint had stopped holding regardless. The split survives
// because it costs nothing and `allergyDietary.ts` derives its enums from these
// arrays rather than duplicating them; merging the two is a live option, not a
// requirement.
//
// `ALLERGIES` has one consumer left: `IngredientAllergenMappingSchema`, which
// validates `data/ingredient-allergens.json` — the closed hand-verified record that
// `npm run validate` still checks and nothing reads (#224). It is not a
// household-facing vocabulary.

export const ALLERGIES = [
  "gluten",
  "dairy_lactose",
  "egg",
  "tree_nuts",
  "peanuts",
  "shellfish",
  "fish",
  "soy",
] as const;
export type Allergy = (typeof ALLERGIES)[number];

export const DIETARY_FLAGS = [
  "vegetarian",
  "vegan",
  "high_protein_preference",
] as const;
export type DietaryFlag = (typeof DIETARY_FLAGS)[number];
