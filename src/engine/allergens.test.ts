import { describe, expect, it } from "vitest";
import { AllergySchema } from "../schema/allergyDietary.js";
import { effectiveAllergens, isIngredientExcluded } from "./allergens.js";
import { makeEngineData, makeIngredient } from "./__fixtures__/engineData.js";

const data = makeEngineData({
  ingredients: [
    makeIngredient("morot"),
    makeIngredient("vetemjol"),
    makeIngredient("saknad-rad"),
    makeIngredient("overifierad"),
  ],
  allergenMappings: [
    { ingredient_id: "morot", allergens: [], verification_status: "verified" },
    { ingredient_id: "vetemjol", allergens: ["gluten"], verification_status: "verified" },
    // "saknad-rad" deliberately has no mapping row at all.
    { ingredient_id: "overifierad", allergens: [], verification_status: "unverified" },
  ],
});

describe("effectiveAllergens", () => {
  it("returns the row's allergens for a verified row", () => {
    expect([...effectiveAllergens(data, "vetemjol")]).toEqual(["gluten"]);
  });

  it("returns an empty set for a verified row with no allergens", () => {
    expect([...effectiveAllergens(data, "morot")]).toEqual([]);
  });

  it("returns the full locked vocabulary when the mapping row is missing", () => {
    expect([...effectiveAllergens(data, "saknad-rad")].sort()).toEqual(
      [...AllergySchema.options].sort(),
    );
  });

  it("returns the full locked vocabulary for an unverified row", () => {
    expect([...effectiveAllergens(data, "overifierad")].sort()).toEqual(
      [...AllergySchema.options].sort(),
    );
  });
});

describe("isIngredientExcluded", () => {
  it("excludes an ingredient whose verified row contains the household's allergen", () => {
    expect(isIngredientExcluded(data, "vetemjol", ["gluten"])).toBe(true);
  });

  it("does not exclude an ingredient whose verified row lacks the household's allergen", () => {
    expect(isIngredientExcluded(data, "vetemjol", ["fish"])).toBe(false);
    expect(isIngredientExcluded(data, "morot", ["gluten"])).toBe(false);
  });

  // §5.4 fail-safe rule: missing and unverified rows behave exactly like a row that
  // contains the allergen — for every allergen in the vocabulary, never permissive.
  it.each(AllergySchema.options)("excludes an ingredient with no mapping row (%s)", (allergy) => {
    expect(isIngredientExcluded(data, "saknad-rad", [allergy])).toBe(true);
  });

  it.each(AllergySchema.options)("excludes an ingredient with an unverified row (%s)", (allergy) => {
    expect(isIngredientExcluded(data, "overifierad", [allergy])).toBe(true);
  });

  // Fails closed on its own, without depending on the CLI validator's coverage check
  // having been run: an ingredient the catalog does not know about is excluded for
  // every household, including one with no allergies at all.
  it.each(AllergySchema.options)(
    "excludes an ingredient absent from the catalog (%s)",
    (allergy) => {
      expect(isIngredientExcluded(data, "finns-inte", [allergy])).toBe(true);
    },
  );

  it("excludes an ingredient absent from the catalog even for a household with no allergies", () => {
    expect(isIngredientExcluded(data, "finns-inte", [])).toBe(true);
  });

  it("excludes an ingredient absent from the catalog even when a mapping row exists for it", () => {
    const orphanMapping = makeEngineData({
      ingredients: [],
      allergenMappings: [
        { ingredient_id: "finns-inte", allergens: [], verification_status: "verified" },
      ],
    });

    expect(isIngredientExcluded(orphanMapping, "finns-inte", ["gluten"])).toBe(true);
  });

  it("applies no allergen filter for a household with no allergies", () => {
    // An unverified row is not itself a reason to exclude — there is nothing to
    // exclude against. This is the one place the rule is allergy-relative.
    expect(isIngredientExcluded(data, "overifierad", [])).toBe(false);
    expect(isIngredientExcluded(data, "vetemjol", [])).toBe(false);
  });

  it("excludes when any one of several household allergies matches", () => {
    expect(isIngredientExcluded(data, "vetemjol", ["fish", "gluten"])).toBe(true);
  });
});
