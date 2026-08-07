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
