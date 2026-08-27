import { describe, expect, it } from "vitest";
import type { GeneratedDishOutput } from "../schema/generatedDish.js";
import {
  isGeneratedDishVisibleToHousehold,
  resolveGeneratedDish,
  resolveIngredientName,
} from "./generatedDish.js";
import { passesHardDietaryFilter } from "./candidates.js";
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

describe("isGeneratedDishVisibleToHousehold — what is left of the Tier 2 gate", () => {
  it("still shows a dish with an unresolvable ingredient name, and marks it unverified", () => {
    // Behaviour preservation, not a relaxation: before #224 this dish was withheld
    // only from a household that had *declared an allergy*, on the fail-safe reading
    // that an ingredient we cannot identify might contain anything. With no allergies
    // declared it was shown and marked. Every household is now that household.
    const resolved = resolveGeneratedDish(
      data,
      dishOutput({ ingredients: [{ role: "protein", name: "flygande fisk" }] }),
    );

    expect(resolved.hasUnverifiedContent).toBe(true);
    expect(isGeneratedDishVisibleToHousehold(data, resolved)).toBe(true);
  });

  it("withholds a dish whose slot carries an ingredient id the catalog does not know", () => {
    // Constructed directly: `resolveGeneratedDish` only ever sets an id it just looked
    // up, so it cannot produce this. That is the point — the gate is defence in depth
    // at the boundary a future path would arrive through, and a test is the only thing
    // that keeps it from being deleted as dead on a reading of today's call graph.
    const resolved = {
      ...resolveGeneratedDish(data, dishOutput({ ingredients: [{ role: "protein", name: "kyckling" }] })),
      slots: [{ role: "protein" as const, proposedName: "spökingrediens", ingredientId: "finns-inte" }],
    };

    expect(isGeneratedDishVisibleToHousehold(data, resolved)).toBe(false);
  });

  it("shows a fully-resolved dish", () => {
    const resolved = resolveGeneratedDish(
      data,
      dishOutput({
        ingredients: [
          { role: "protein", name: "kyckling" },
          { role: "starch", name: "potatis" },
        ],
      }),
    );

    expect(isGeneratedDishVisibleToHousehold(data, resolved)).toBe(true);
  });

  it("does not consult dietary flags — that filter runs on dietaryTags, elsewhere", () => {
    // `passesHardDietaryFilter` (candidates.ts) is what fails a generated dish for a
    // vegan household, and it is deliberately not this function's job. Asserted so a
    // future edit does not quietly move one of the two filters into the other.
    const resolved = resolveGeneratedDish(
      data,
      dishOutput({ ingredients: [{ role: "protein", name: "kyckling" }] }),
    );

    expect(isGeneratedDishVisibleToHousehold(data, resolved)).toBe(true);
    expect(passesHardDietaryFilter(resolved.dietaryTags, ["vegan"])).toBe(false);
  });
});
