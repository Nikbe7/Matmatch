import { z } from "zod";
import {
  CuisineSchema,
  FamiliaritySchema,
  IngredientSlotRoleSchema,
  MealTypeSchema,
  PrepTimeBandSchema,
  ProteinGroupSchema,
} from "./recipeTemplate.js";

// Tier 2 on-demand generation (issue #113, ARCHITECTURE.md §4.1/§4.2, DECISION_LOG
// 2026-08-05 "AI tiering, cost control and monetization sequencing").
//
// This is the model's *proposed* dish, not a trusted RecipeTemplate: notice what is
// absent relative to RecipeTemplateSchema (src/schema/recipeTemplate.ts) — no
// ingredient_id (only a free-text proposed name), no cost_tier, no dietary_tags. The
// hard rule (DECISION_LOG 2026-08-05): "Tier 2 may invent the dish, never the
// ingredients." An ingredient id, an allergen, or a cost figure is never something
// the model asserts; those are always derived by our own code from the resolved,
// curated catalog (src/engine/generatedDish.ts). This schema is deliberately shared
// by src/ai/ (which validates the model's raw response against it) and src/engine/
// (which resolves it) rather than living only under src/ai/, matching how
// src/schema/recipeTemplate.ts is shared by the same two layers — it keeps the
// engine's dependency on the AI layer at zero, matching every other engine module.

export const GeneratedDishIngredientSchema = z.object({
  role: IngredientSlotRoleSchema,
  // The model's proposed Swedish ingredient name, verbatim from the catalog list it
  // was given — resolved (or not) against the real catalog by
  // src/engine/generatedDish.ts. Never trusted as an id.
  name: z.string().trim().min(1).max(80),
});
export type GeneratedDishIngredient = z.infer<typeof GeneratedDishIngredientSchema>;

export const GeneratedDishOutputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  cuisine: CuisineSchema,
  prep_time_band: PrepTimeBandSchema,
  protein_group: ProteinGroupSchema,
  meal_types: z
    .array(MealTypeSchema)
    .min(1)
    .refine((mealTypes) => new Set(mealTypes).size === mealTypes.length, {
      message: "meal_types must not contain duplicate values",
    }),
  familiarity: FamiliaritySchema,
  ingredients: z.array(GeneratedDishIngredientSchema).min(1).max(10),
});
export type GeneratedDishOutput = z.infer<typeof GeneratedDishOutputSchema>;
