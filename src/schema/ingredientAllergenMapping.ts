import { z } from "zod";
import { SlugIdSchema } from "./ingredient.js";
import { AllergySchema } from "./allergyDietary.js";

// ARCHITECTURE.md §5.4 — Ingredient-to-allergen mapping

export const VerificationStatusSchema = z.enum(["unverified", "verified"]);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

export const IngredientAllergenMappingSchema = z.object({
  ingredient_id: SlugIdSchema,
  allergens: z
    .array(AllergySchema)
    .refine((allergens) => new Set(allergens).size === allergens.length, {
      message: "allergens must not contain duplicate values",
    }),
  verification_status: VerificationStatusSchema,
});
export type IngredientAllergenMapping = z.infer<typeof IngredientAllergenMappingSchema>;
