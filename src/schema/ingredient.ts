import { z } from "zod";

// ASCII-slug id constraint, shared by Ingredient and RecipeTemplate. The catalog is
// authored in Swedish (gul lök, fläskfilé, kantareller); without this, ids would
// inherit åäö and risk NFC/NFD normalization mismatches in URLs, DB indexes,
// filenames, and grep — the same class of invisible bug as the ₤/£ homoglyph, since
// two visually identical ö can be different byte sequences.
export const SlugIdSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

// ARCHITECTURE.md §5.1 — Ingredient schema

export const CostTierSchema = z.enum(["budget", "mid", "premium"]);
export type CostTier = z.infer<typeof CostTierSchema>;

export const IngredientCategorySchema = z.enum([
  "protein",
  "vegetable",
  "fruit",
  "dairy",
  "starch",
  "spice_aromatic",
  "fat_oil",
  "condiment",
]);
export type IngredientCategory = z.infer<typeof IngredientCategorySchema>;

export const SeasonalityStrengthSchema = z.enum(["strong", "weak"]);
export type SeasonalityStrength = z.infer<typeof SeasonalityStrengthSchema>;

export const IngredientSchema = z
  .object({
    id: SlugIdSchema,
    name: z.string().min(1),
    category: IngredientCategorySchema,
    default_cost_tier: CostTierSchema,
    peak_months: z
      .array(z.number().int().min(1).max(12))
      .refine((months) => new Set(months).size === months.length, {
        message: "peak_months must not contain duplicate values",
      }),
    available_year_round: z.boolean(),
    seasonality_strength: SeasonalityStrengthSchema,
  })
  .refine(
    (ingredient) => ingredient.available_year_round || ingredient.peak_months.length > 0,
    {
      message:
        "an ingredient that is not available_year_round must have at least one peak_months entry",
      path: ["peak_months"],
    },
  )
  .refine(
    (ingredient) => !ingredient.available_year_round || ingredient.peak_months.length === 0,
    {
      message: "an ingredient that is available_year_round must have an empty peak_months array",
      path: ["peak_months"],
    },
  );
export type Ingredient = z.infer<typeof IngredientSchema>;
