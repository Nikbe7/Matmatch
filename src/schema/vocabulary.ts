// ARCHITECTURE.md §5.2 — dietary vocabulary (and the allergy value list), locked
// values only.
//
// Zod-free by design, and still for the original reason: the frontend imports this
// module directly to render a chip list, and must not pull in zod's enum
// construction just to read the values. What changed with #224 is only *which* list
// — the onboarding allergy chips are gone, and web/src/App.tsx now imports
// `DIETARY_FLAGS` here for the profile's dietary chips. `allergyDietary.ts` derives
// its zod enums from these same arrays rather than duplicating them.
//
// The saving is smaller than it looks: web/ already imports `QuantityUnitSchema`
// from `recipeTemplate.ts` as a value, so zod is in the bundle regardless. The split
// is kept because it is free and the boundary is real, not because it is load-bearing
// for bundle size.
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
