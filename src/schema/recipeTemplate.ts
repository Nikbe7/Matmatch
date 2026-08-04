import { z } from "zod";
import { CostTierSchema, SlugIdSchema } from "./ingredient.js";
import { DietaryFlagSchema } from "./allergyDietary.js";

// ARCHITECTURE.md §5.3 — RecipeTemplate schema & coverage matrix

export const ProteinGroupSchema = z.enum([
  "chicken_poultry",
  "beef_pork",
  "fish_seafood",
  "vegetarian_vegan",
  "egg_dairy_pantry",
]);
export type ProteinGroup = z.infer<typeof ProteinGroupSchema>;

export const CuisineSchema = z.enum([
  "swedish_nordic",
  "italian_mediterranean",
  "asian",
  "mexican_texmex",
  "middle_eastern",
  "american_comfort",
]);
export type Cuisine = z.infer<typeof CuisineSchema>;

export const PrepTimeBandSchema = z.enum(["<20min", "20-40min", "40min+"]);
export type PrepTimeBand = z.infer<typeof PrepTimeBandSchema>;

// Authored, not derived (contrast dietary_tags/cost_tier — DECISION_LOG
// 2026-07-31) — which meals a dish fits is a judgment call about the dish itself,
// not something computable from ingredient_slots[]. See DECISION_LOG for why this
// is an array rather than a boolean.
export const MealTypeSchema = z.enum(["breakfast", "lunch", "dinner"]);
export type MealType = z.infer<typeof MealTypeSchema>;

// Slot role is its own vocabulary, distinct from Ingredient.category — "aromatic"
// here maps conceptually to the "spice_aromatic" ingredient category, but the two
// strings are never interchangeable in code. Translating between them (e.g. when
// filling a slot from the ingredient catalog) is Meal Engine logic, not a string
// match against this enum — no such mapping is implemented here.
export const IngredientSlotRoleSchema = z.enum([
  "protein",
  "starch",
  "vegetable",
  "aromatic",
  "dairy",
]);
export type IngredientSlotRole = z.infer<typeof IngredientSlotRoleSchema>;

export const IngredientSlotSchema = z.object({
  role: IngredientSlotRoleSchema,
  ingredient_id: z.string().min(1),
  substitutable: z.boolean(),
});
export type IngredientSlot = z.infer<typeof IngredientSlotSchema>;

export const RecipeTemplateSchema = z.object({
  id: SlugIdSchema,
  name: z.string().min(1),
  protein_group: ProteinGroupSchema,
  cuisine: CuisineSchema,
  cost_tier: CostTierSchema,
  prep_time_band: PrepTimeBandSchema,
  dietary_tags: z.array(DietaryFlagSchema),
  // Required, no default: a template missing this must fail validation rather
  // than silently inherit "dinner" (see DECISION_LOG).
  meal_types: z
    .array(MealTypeSchema)
    .min(1)
    .refine((mealTypes) => new Set(mealTypes).size === mealTypes.length, {
      message: "meal_types must not contain duplicate values",
    }),
  ingredient_slots: z.array(IngredientSlotSchema).min(1),
});
export type RecipeTemplate = z.infer<typeof RecipeTemplateSchema>;
