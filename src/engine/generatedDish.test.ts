import { describe, expect, it } from "vitest";
import { AllergySchema, type Allergy } from "../schema/allergyDietary.js";
import type { GeneratedDishOutput } from "../schema/generatedDish.js";
import {
  isGeneratedDishVisibleToHousehold,
  resolveGeneratedDish,
  resolveIngredientName,
} from "./generatedDish.js";
import { makeEngineData, makeIngredient } from "./__fixtures__/engineData.js";

const data = makeEngineData({
  ingredients: [
    makeIngredient("kyckling", { name: "kyckling", default_cost_tier: "mid" }),
    makeIngredient("mandelmjolk", { name: "mandelmjölk", default_cost_tier: "premium" }),
    makeIngredient("mandel", { name: "mandel", default_cost_tier: "premium" }),
    makeIngredient("gul-lok", { name: "gul lök", default_cost_tier: "budget" }),
    makeIngredient("potatis", { name: "potatis", category: "starch", default_cost_tier: "budget" }),
    makeIngredient("overifierad", { name: "overifierad ingrediens", default_cost_tier: "budget" }),
  ],
  allergenMappings: [
    { ingredient_id: "kyckling", allergens: [], verification_status: "verified" },
    { ingredient_id: "mandelmjolk", allergens: ["tree_nuts"], verification_status: "verified" },
    { ingredient_id: "mandel", allergens: ["tree_nuts"], verification_status: "verified" },
    { ingredient_id: "gul-lok", allergens: [], verification_status: "verified" },
    { ingredient_id: "potatis", allergens: [], verification_status: "verified" },
    // Deliberately missing mapping row for "overifierad" — same fail-safe posture
    // as allergens.test.ts, exercised through the generated-dish path too.
  ],
});

function dishOutput(overrides: Partial<GeneratedDishOutput> = {}): GeneratedDishOutput {
  return {
    name: "Kycklinggryta",
    cuisine: "swedish_nordic",
    prep_time_band: "20-40min",
    protein_group: "chicken_poultry",
    meal_types: ["dinner"],
    familiarity: "everyday",
    ingredients: [{ role: "protein", name: "kyckling" }],
    ...overrides,
  };
}

describe("resolveIngredientName", () => {
  it("matches a catalog name exactly, case- and whitespace-insensitively", () => {
    expect(resolveIngredientName(data, "Kyckling")).toBe("kyckling");
    expect(resolveIngredientName(data, "  gul   lök  ")).toBe("gul-lok");
  });

  it("matches via the ascii-slug fallback when the model drops diacritics", () => {
    expect(resolveIngredientName(data, "gul lok")).toBe("gul-lok");
  });

  it("does not fuzzy-match a substring or a near-miss of a different real ingredient", () => {
    // "mandel" and "mandelmjölk" are two distinct catalog ingredients with
    // different allergen rows in real data (DECISION_LOG 2026-07-31, tree-nut
    // boundary). A resolver that let "mandel" match "mandelmjölk" (or vice versa)
    // would silently attach the wrong verified allergen row — exactly the
    // fail-open failure exact matching exists to prevent.
    expect(resolveIngredientName(data, "mandel")).toBe("mandel");
    expect(resolveIngredientName(data, "mandelmjölk")).toBe("mandelmjolk");
    expect(resolveIngredientName(data, "mandelolja")).toBeUndefined();
  });

  it("returns undefined for a name absent from the catalog", () => {
    expect(resolveIngredientName(data, "flygande fisk")).toBeUndefined();
  });
});

describe("resolveGeneratedDish", () => {
  it("resolves every ingredient and reports no unverified content when all match", () => {
    const output = dishOutput({
      ingredients: [
        { role: "protein", name: "kyckling" },
        { role: "starch", name: "potatis" },
      ],
    });

    const resolved = resolveGeneratedDish(data, output);

    expect(resolved.hasUnverifiedContent).toBe(false);
    expect(resolved.unresolvedNames).toEqual([]);
    expect(resolved.slots.map((slot) => slot.ingredientId)).toEqual(["kyckling", "potatis"]);
  });

  it("marks unresolved names and lists each distinct one once", () => {
    const output = dishOutput({
      ingredients: [
        { role: "protein", name: "flygande fisk" },
        { role: "vegetable", name: "flygande fisk" },
        { role: "aromatic", name: "annan okänd ingrediens" },
      ],
    });

    const resolved = resolveGeneratedDish(data, output);

    expect(resolved.hasUnverifiedContent).toBe(true);
    expect(resolved.unresolvedNames).toEqual(["flygande fisk", "annan okänd ingrediens"]);
  });

  it("derives cost_tier as the highest tier among resolved ingredients", () => {
    const output = dishOutput({
      ingredients: [
        { role: "protein", name: "kyckling" }, // mid
        { role: "dairy", name: "mandelmjölk" }, // premium
      ],
    });

    expect(resolveGeneratedDish(data, output).costTier).toBe("premium");
  });

  it("never derives a cost_tier when any ingredient is unresolved", () => {
    const output = dishOutput({
      ingredients: [
        { role: "protein", name: "kyckling" },
        { role: "vegetable", name: "flygande fisk" },
      ],
    });

    expect(resolveGeneratedDish(data, output).costTier).toBeUndefined();
  });

  it("derives high_protein_preference only when there is no starch slot", () => {
    const noStarch = dishOutput({ ingredients: [{ role: "protein", name: "kyckling" }] });
    const withStarch = dishOutput({
      ingredients: [
        { role: "protein", name: "kyckling" },
        { role: "starch", name: "potatis" },
      ],
    });

    expect(resolveGeneratedDish(data, noStarch).dietaryTags).toEqual(["high_protein_preference"]);
    expect(resolveGeneratedDish(data, withStarch).dietaryTags).toEqual([]);
  });

  it("derives dietary_tags from slot roles regardless of resolution, unlike cost_tier", () => {
    const output = dishOutput({ ingredients: [{ role: "protein", name: "flygande fisk" }] });
    const resolved = resolveGeneratedDish(data, output);

    expect(resolved.hasUnverifiedContent).toBe(true);
    expect(resolved.dietaryTags).toEqual(["high_protein_preference"]);
  });
});

describe("isGeneratedDishVisibleToHousehold — allergy gate, exhaustive over the locked vocabulary", () => {
  it.each(AllergySchema.options)(
    "withholds an unresolved-ingredient dish from a household declaring %s",
    (allergy: Allergy) => {
      const resolved = resolveGeneratedDish(
        data,
        dishOutput({ ingredients: [{ role: "protein", name: "flygande fisk" }] }),
      );

      expect(isGeneratedDishVisibleToHousehold(data, resolved, [allergy])).toBe(false);
    },
  );

  it("shows an unresolved-ingredient dish to a household with no declared allergies", () => {
    const resolved = resolveGeneratedDish(
      data,
      dishOutput({ ingredients: [{ role: "protein", name: "flygande fisk" }] }),
    );

    expect(isGeneratedDishVisibleToHousehold(data, resolved, [])).toBe(true);
  });

  it.each(AllergySchema.options)(
    "withholds a fully-resolved dish containing %s from a household declaring it",
    (allergy: Allergy) => {
      // mandelmjolk is verified tree_nuts-only; test each allergy against a dish
      // whose only real allergen is tree_nuts to exercise both the "matches" and
      // "does not match" branches across the full vocabulary.
      const resolved = resolveGeneratedDish(
        data,
        dishOutput({ ingredients: [{ role: "dairy", name: "mandelmjölk" }] }),
      );

      const shouldBeWithheld = allergy === "tree_nuts";
      expect(isGeneratedDishVisibleToHousehold(data, resolved, [allergy])).toBe(!shouldBeWithheld);
    },
  );

  it.each(AllergySchema.options)(
    "withholds a resolved-but-unverified-mapping ingredient from any household declaring %s",
    (allergy: Allergy) => {
      // "overifierad" resolves to a real catalog id but has no allergen mapping row
      // — the existing §5.4 fail-safe rule (allergens.ts) must still apply through
      // the generated-dish path, not just for unresolved names.
      const resolved = resolveGeneratedDish(
        data,
        dishOutput({ ingredients: [{ role: "vegetable", name: "overifierad ingrediens" }] }),
      );

      expect(isGeneratedDishVisibleToHousehold(data, resolved, [allergy])).toBe(false);
    },
  );

  it("shows a fully-resolved, fully-verified, allergen-free dish to any household", () => {
    const resolved = resolveGeneratedDish(
      data,
      dishOutput({
        ingredients: [
          { role: "protein", name: "kyckling" },
          { role: "starch", name: "potatis" },
        ],
      }),
    );

    expect(isGeneratedDishVisibleToHousehold(data, resolved, [])).toBe(true);
    expect(isGeneratedDishVisibleToHousehold(data, resolved, ["gluten", "fish"])).toBe(true);
  });
});
