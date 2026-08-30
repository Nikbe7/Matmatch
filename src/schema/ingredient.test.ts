import { describe, expect, it } from "vitest";
import {
  CostTierSchema,
  IngredientCategorySchema,
  IngredientSchema,
  SeasonalityStrengthSchema,
  SlugIdSchema,
} from "./ingredient.js";

describe("IngredientSchema", () => {
  it("parses a valid fixture", () => {
    const fixture = {
      id: "potatis",
      name: "Potatis",
      category: "starch",
      default_cost_tier: "budget",
      peak_months: [8, 9, 10],
      available_year_round: false,
      seasonality_strength: "weak",
    };

    expect(IngredientSchema.parse(fixture)).toEqual(fixture);
  });

  it("parses an optional variety_of key (#221)", () => {
    const fixture = {
      id: "jasminris",
      name: "jasminris",
      variety_of: "ris",
      category: "starch",
      default_cost_tier: "budget",
      peak_months: [],
      available_year_round: true,
      seasonality_strength: "weak",
    };

    expect(IngredientSchema.parse(fixture)).toEqual(fixture);
  });

  it("leaves variety_of absent rather than defaulting it", () => {
    // The absence has to survive parsing: two ingredients that both lack a key are
    // never varieties of each other, and a default (""/null) would be a value two
    // unrelated ingredients could compare equal on.
    const parsed = IngredientSchema.parse({
      id: "vitlok",
      name: "vitlök",
      category: "spice_aromatic",
      default_cost_tier: "budget",
      peak_months: [],
      available_year_round: true,
      seasonality_strength: "weak",
    });

    expect("variety_of" in parsed).toBe(false);
  });

  it("rejects a variety_of that is not a slug", () => {
    const result = IngredientSchema.safeParse({
      id: "nypotatis",
      name: "nypotatis",
      variety_of: "Ny Potatis",
      category: "starch",
      default_cost_tier: "mid",
      peak_months: [6, 7],
      available_year_round: false,
      seasonality_strength: "strong",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["variety_of"] });
  });

  it("accepts an empty peak_months array for non-seasonal ingredients", () => {
    const fixture = {
      id: "rapsolja",
      name: "Rapsolja",
      category: "fat_oil",
      default_cost_tier: "budget",
      peak_months: [],
      available_year_round: true,
      seasonality_strength: "weak",
    };

    expect(IngredientSchema.parse(fixture)).toEqual(fixture);
  });

  it("rejects duplicate values in peak_months", () => {
    const fixture = {
      id: "jordgubbe",
      name: "Jordgubbe",
      category: "fruit",
      default_cost_tier: "mid",
      peak_months: [6, 7, 6],
      available_year_round: false,
      seasonality_strength: "strong",
    };

    expect(IngredientSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects available_year_round: false with an empty peak_months", () => {
    const fixture = {
      id: "omojlig-ingrediens",
      name: "Omöjlig ingrediens",
      category: "vegetable",
      default_cost_tier: "mid",
      peak_months: [],
      available_year_round: false,
      seasonality_strength: "strong",
    };

    expect(IngredientSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects available_year_round: true with a non-empty peak_months", () => {
    const fixture = {
      id: "motsagelsefull-ingrediens",
      name: "Motsägelsefull ingrediens",
      category: "vegetable",
      default_cost_tier: "mid",
      peak_months: [7],
      available_year_round: true,
      seasonality_strength: "weak",
    };

    expect(IngredientSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects a missing seasonality_strength", () => {
    const fixture = {
      id: "tomat",
      name: "Tomat",
      category: "vegetable",
      default_cost_tier: "mid",
      peak_months: [7, 8],
      available_year_round: true,
    };

    expect(IngredientSchema.safeParse(fixture).success).toBe(false);
  });

});

describe("SlugIdSchema", () => {
  it("accepts a hyphenated lowercase ASCII slug id", () => {
    expect(SlugIdSchema.safeParse("gul-lok").success).toBe(true);
  });

  it("rejects an id containing åäö", () => {
    expect(SlugIdSchema.safeParse("gul-lök").success).toBe(false);
  });

  it("rejects an id with uppercase letters", () => {
    expect(SlugIdSchema.safeParse("Gul-Lok").success).toBe(false);
  });

  it("rejects an id using underscores instead of hyphens", () => {
    expect(SlugIdSchema.safeParse("gul_lok").success).toBe(false);
  });
});

describe("IngredientCategorySchema", () => {
  it("rejects a value outside the locked enum", () => {
    expect(IngredientCategorySchema.safeParse("meat").success).toBe(false);
  });
});

describe("CostTierSchema", () => {
  it("rejects a value outside the locked enum", () => {
    expect(CostTierSchema.safeParse("cheap").success).toBe(false);
  });

  it("rejects the retired glyph values", () => {
    expect(CostTierSchema.safeParse("₤").success).toBe(false);
  });
});

describe("SeasonalityStrengthSchema", () => {
  it("rejects a value outside the locked enum", () => {
    expect(SeasonalityStrengthSchema.safeParse("medium").success).toBe(false);
  });
});
