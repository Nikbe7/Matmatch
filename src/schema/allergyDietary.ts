import { z } from "zod";

// ARCHITECTURE.md §5.2 — Allergy & dietary vocabulary

// Plain arrays, not just the zod enums below: the frontend reads these directly so
// the onboarding chip list is derived from the locked vocabulary rather than a
// hand-typed parallel list. Zod validation and inferred types are unchanged — the
// enums are now built from these arrays instead of duplicating the values.
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
export const AllergySchema = z.enum(ALLERGIES);
export type Allergy = z.infer<typeof AllergySchema>;

export const DIETARY_FLAGS = [
  "vegetarian",
  "vegan",
  "high_protein_preference",
] as const;
export const DietaryFlagSchema = z.enum(DIETARY_FLAGS);
export type DietaryFlag = z.infer<typeof DietaryFlagSchema>;
