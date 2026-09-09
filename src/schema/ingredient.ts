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

// The kitchen a dish cooks from. Lives here rather than in recipeTemplate.ts (which
// re-exports it, so every existing importer is unaffected) because both a template
// and an ingredient now name cuisines, and ingredient.ts is the base module of the
// pair — recipeTemplate.ts already imports SlugIdSchema and CostTierSchema from here,
// so the dependency can only run in this direction without a cycle.
export const CuisineSchema = z.enum([
  "swedish_nordic",
  "italian_mediterranean",
  "asian",
  "mexican_texmex",
  "middle_eastern",
  "american_comfort",
]);
export type Cuisine = z.infer<typeof CuisineSchema>;

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
    variety_of: SlugIdSchema.optional(),
    // #222 — the kitchens this ingredient belongs in. Absent is the normal case and
    // means "belongs anywhere"; present means "belongs *only* here", so it is a
    // closed list and never a hint. Read by `substituteCandidateIds` only: it decides
    // what the swap popover offers, never what a template may contain and never
    // whether a dish is shown.
    //
    // The curation rule (#222): mark an ingredient only when it is a named product of
    // a specific kitchen — you buy it because you are cooking that food, and putting
    // it in another kitchen's dish changes what the dish is (sambal oelek, currypasta,
    // bambuskott, tacoskal). Not "most often used in": jasminris is asian by origin
    // but it is what a Swedish household's rice cupboard actually holds, and marking
    // it would take away a swap people make on purpose. 15 of 206 ingredients carry
    // a list at all.
    //
    // Cannot be empty — an ingredient that belongs in no kitchen is a curation slip,
    // not a statement, and would silently vanish from every popover. `validate` also
    // holds the list against the templates: a cuisine that uses this ingredient must
    // appear here, or the two curated files contradict each other.
    cuisines: z
      .array(CuisineSchema)
      .min(1)
      .refine((cuisines) => new Set(cuisines).size === cuisines.length, {
        message: "cuisines must not contain duplicate values",
      })
      .optional(),
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
