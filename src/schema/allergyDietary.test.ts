import { describe, expect, it } from "vitest";
import { AllergySchema, DietaryFlagSchema } from "./allergyDietary.js";

describe("AllergySchema", () => {
  it("parses every locked allergy value", () => {
    const allergies = [
      "gluten",
      "dairy_lactose",
      "egg",
      "tree_nuts",
      "peanuts",
      "shellfish",
      "fish",
      "soy",
    ];

    for (const allergy of allergies) {
      expect(AllergySchema.parse(allergy)).toBe(allergy);
    }
  });

  it("rejects a value outside the locked enum", () => {
    expect(AllergySchema.safeParse("sesame").success).toBe(false);
  });
});

describe("DietaryFlagSchema", () => {
  it("parses every locked dietary flag value", () => {
    const flags = ["vegetarian", "vegan", "high_protein_preference"];

    for (const flag of flags) {
      expect(DietaryFlagSchema.parse(flag)).toBe(flag);
    }
  });

  it("rejects a value outside the locked enum", () => {
    expect(DietaryFlagSchema.safeParse("pescatarian").success).toBe(false);
  });
});
