import { describe, expect, it } from "vitest";
import { makeEngineData, makeIngredient } from "../engine/__fixtures__/engineData.js";
import type { Allergy } from "../schema/allergyDietary.js";
import { ALLERGIES } from "../schema/allergyDietary.js";
import { buildExcludedMainIngredients } from "./guidedCatalog.js";

// buildExcludedMainIngredients backs step 2's filter-miss explanation (#110,
// requirement 4): a catalog protein the query matched but the household cannot
// select, named with the specific allergy that excludes it. Built with fixture data
// rather than data/*.json because the real catalog has no verified protein excluded
// by tree_nuts or peanuts (nothing in it needs them) — the full locked vocabulary
// can only be exercised this way, matching engineData.ts fixtures' own rationale.

/** One protein per allergy, each verified and containing exactly that allergen. */
function proteinFixturesForEveryAllergy() {
  return ALLERGIES.map((allergy) => ({
    ingredient: makeIngredient(`${allergy}-protein`, { name: `${allergy}-protein`, category: "protein" as const }),
    mapping: {
      ingredient_id: `${allergy}-protein`,
      allergens: [allergy],
      verification_status: "verified" as const,
    },
  }));
}

describe("buildExcludedMainIngredients", () => {
  it("returns nothing for a household with no allergies", () => {
    const fixtures = proteinFixturesForEveryAllergy();
    const data = makeEngineData({
      ingredients: fixtures.map((f) => f.ingredient),
      allergenMappings: fixtures.map((f) => f.mapping),
    });

    expect(buildExcludedMainIngredients(data, [])).toEqual([]);
  });

  it("names the excluding allergy for every value in the locked vocabulary, not a sample", () => {
    const fixtures = proteinFixturesForEveryAllergy();
    const data = makeEngineData({
      ingredients: fixtures.map((f) => f.ingredient),
      allergenMappings: fixtures.map((f) => f.mapping),
    });

    for (const allergy of ALLERGIES) {
      const excluded = buildExcludedMainIngredients(data, [allergy]);

      expect(excluded).toEqual([
        { id: `${allergy}-protein`, name: `${allergy}-protein`, allergies: [allergy] },
      ]);
    }
  });

  it("names every matching allergy when an ingredient carries more than one", () => {
    const data = makeEngineData({
      ingredients: [makeIngredient("blodpudding", { name: "Blodpudding", category: "protein" })],
      allergenMappings: [
        {
          ingredient_id: "blodpudding",
          allergens: ["gluten", "dairy_lactose", "egg"],
          verification_status: "verified",
        },
      ],
    });

    const excluded = buildExcludedMainIngredients(data, ["gluten", "egg", "shellfish"]);

    expect(excluded).toEqual([
      { id: "blodpudding", name: "Blodpudding", allergies: ["gluten", "egg"] },
    ]);
  });

  it("omits an ingredient the household's allergies do not actually touch", () => {
    const data = makeEngineData({
      ingredients: [makeIngredient("tofu", { name: "Tofu", category: "protein" })],
      allergenMappings: [
        { ingredient_id: "tofu", allergens: ["soy"], verification_status: "verified" },
      ],
    });

    expect(buildExcludedMainIngredients(data, ["fish"])).toEqual([]);
  });

  it("ignores non-protein ingredients — step 2 only ever filters the protein grid", () => {
    const data = makeEngineData({
      ingredients: [makeIngredient("gron-ost", { name: "Grönmögelost", category: "dairy" })],
      allergenMappings: [
        { ingredient_id: "gron-ost", allergens: ["dairy_lactose"], verification_status: "verified" },
      ],
    });

    expect(buildExcludedMainIngredients(data, ["dairy_lactose"])).toEqual([]);
  });

  it("never asserts a specific allergy for an unverified or missing row (§5.4's fail-safe is a 'we don't know', not a fact worth naming)", () => {
    const data = makeEngineData({
      ingredients: [
        makeIngredient("ovan-kott", { name: "Ovanligt kött", category: "protein" }),
        makeIngredient("okand-fisk", { name: "Okänd fisk", category: "protein" }),
      ],
      allergenMappings: [
        { ingredient_id: "ovan-kott", allergens: [], verification_status: "unverified" },
        // "okand-fisk" has no mapping row at all.
      ],
    });

    expect(buildExcludedMainIngredients(data, ALLERGIES as unknown as Allergy[])).toEqual([]);
  });

  it("sorts by id, deterministically", () => {
    const data = makeEngineData({
      ingredients: [
        makeIngredient("zebra-kott", { name: "Zebrakött", category: "protein" }),
        makeIngredient("anka", { name: "Anka", category: "protein" }),
      ],
      allergenMappings: [
        { ingredient_id: "zebra-kott", allergens: ["fish"], verification_status: "verified" },
        { ingredient_id: "anka", allergens: ["fish"], verification_status: "verified" },
      ],
    });

    expect(buildExcludedMainIngredients(data, ["fish"]).map((o) => o.id)).toEqual([
      "anka",
      "zebra-kott",
    ]);
  });
});
