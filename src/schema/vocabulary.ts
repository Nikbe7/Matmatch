// ARCHITECTURE.md §5.2 — Allergy & dietary vocabulary, locked values only.
//
// Zod-free by design: the frontend (web/) imports this module directly for its
// onboarding chip list, and must not pull in zod's enum construction (or the zod
// package itself) just to read the list of values. src/schema/allergyDietary.ts
// derives its zod enums from these same arrays rather than duplicating them.

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
