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
    // ARCHITECTURE.md §5.5 / #221 — which everyday product this is a *variety* of.
    //
    // Optional, and its own namespace: the value is a variety-class key, never an
    // ingredient id and never a substitution-group id. Several keys happen to read
    // like both ("ris", "potatis"), which is fine because nothing ever resolves one —
    // the only operation is comparing two ingredients' keys for equality. Milk is why
    // the namespace has to be its own: standardmjölk/mellanmjölk/lättmjölk are
    // varieties of a product the catalog has no ingredient for.
    //
    // A field on the ingredient rather than on the group (the model #221 rejected),
    // because the relation runs between members and not across a group: inside
    // `gradde`, matlagningsgrädde/vispgrädde are varieties while
    // matlagningsgrädde/crème fraîche is a swap. And a field rather than a fifth data
    // file, because every ingredient is a variety of exactly *one* product — unlike
    // group membership, where crème fraîche legitimately sits in two.
    //
    // The curation rule (#221): same shelf in the shop, and the recipe still works —
    // possibly with an adjustment. Crème fraîche and kokosmjölk fall outside it not
    // because they are bad swaps but because you buy them as a different product.
    // Absent is the normal case: 169 of 206 ingredients carry no key at all, and two
    // ingredients that both lack one are never varieties of each other.
    //
    // Since #223 the key resolves into `data/variety-families.json` and `validate`
    // requires it to — the namespace is its own, but no longer open. Membership did
    // not move: it is still a field here, for the reason #221 gave. What changed is
    // that the *family* became a record, because it had to carry curated text of its
    // own (the note shown when pantry coverage bridged two varieties). That record
    // holds `{ id, name, note? }` and nothing else — no substitution semantics, no
    // ranking weight, no cuisine. See `src/schema/varietyFamily.ts`.
    variety_of: SlugIdSchema.optional(),
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
