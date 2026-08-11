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

// Authored, not derived, same rationale as meal_types above: how familiar a dish is
// to a typical Swedish household on an ordinary weekday is a judgment call about the
// dish as a whole, not something computable from ingredient_slots[]. See
// DECISION_LOG for the ranking use (src/engine/ranking.ts) and the evidence bar this
// was assigned under.
export const FamiliaritySchema = z.enum(["everyday", "occasional", "adventurous"]);
export type Familiarity = z.infer<typeof FamiliaritySchema>;

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

// Closed vocabulary, sized to a Swedish kitchen and to what a shopping list has to
// say out loud (DECISION_LOG 2026-08-11, #123). Volume is dl/msk/tsk because that is
// how a Swedish recipe measures — never ml, never cups. `st` keeps naturally counted
// things whole (ägg, paprika, lagerblad) instead of forcing them into grams.
// `klyfta` and `kruka` exist because the catalog names the *product*, not the
// portion of it a dish uses: "2 st vitlök" means two whole bulbs, and fresh herbs
// are sold in pots, so "1 kruka färsk persilja" is what you actually buy.
// No kg/l: converting between magnitudes is a separate decision (#123 out of scope),
// and "900 g" reads fine on a list.
//
// `krm` carries a narrow authoring rule, and it is a rule about discipline rather
// than about measuring: use it only for spices where the amount changes the outcome
// and you cannot taste your way to it — saffran, muskot, kanel, cayenne, malen
// ingefära. Salt and svartpeppar are `to_taste` without exception, as are
// chiliflakes and anything else adjusted at the stove. The failure this prevents is
// a drafter reaching for "2 krm salt" where `to_taste` was correct: that fills the
// shopping list with amounts nobody acts on, and once a few of those are on the list
// `to_taste` stops meaning anything.
export const QuantityUnitSchema = z.enum(["g", "dl", "msk", "tsk", "krm", "st", "klyfta", "kruka"]);
export type QuantityUnit = z.infer<typeof QuantityUnitSchema>;

/**
 * What one slot contributes, at `REFERENCE_PORTIONS` (src/engine/quantities.ts).
 *
 * A union rather than an optional number, so "this slot has no sensible amount" is a
 * stated value and not an absent one: salt, svartpeppar and chiliflakes are seasoned
 * to taste, and the alternative to saying so is either inventing "0.5 g" or leaving a
 * hole that reads as unfinished data. Both kinds are curated — never model output at
 * request time (CLAUDE.md; DECISION_LOG 2026-08-10 rule 3).
 */
export const SlotQuantitySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("amount"),
    amount: z.number().positive(),
    unit: QuantityUnitSchema,
  }),
  z.object({ kind: z.literal("to_taste") }),
]);
export type SlotQuantity = z.infer<typeof SlotQuantitySchema>;

export const IngredientSlotSchema = z.object({
  role: IngredientSlotRoleSchema,
  ingredient_id: z.string().min(1),
  substitutable: z.boolean(),
  // Required, no default, same discipline as meal_types/familiarity above: a slot
  // with neither an amount nor the explicit `to_taste` marker must fail validation
  // rather than render as a bare ingredient name on a shopping list (#123). There is
  // deliberately no fallback — a missing quantity is missing curated data.
  quantity: SlotQuantitySchema,
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
  // Required, no default: a ranking weight this consequential must not silently
  // default to "everyday" for an unclassified row (see DECISION_LOG).
  familiarity: FamiliaritySchema,
  ingredient_slots: z.array(IngredientSlotSchema).min(1),
});
export type RecipeTemplate = z.infer<typeof RecipeTemplateSchema>;
