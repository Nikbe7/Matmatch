import { z } from "zod";

// ARCHITECTURE.md §5.2 — Allergy & dietary vocabulary

export const AllergySchema = z.enum([
  "gluten",
  "dairy_lactose",
  "egg",
  "tree_nuts",
  "peanuts",
  "shellfish",
  "fish",
  "soy",
]);
export type Allergy = z.infer<typeof AllergySchema>;

export const DietaryFlagSchema = z.enum([
  "vegetarian",
  "vegan",
  "high_protein_preference",
]);
export type DietaryFlag = z.infer<typeof DietaryFlagSchema>;
