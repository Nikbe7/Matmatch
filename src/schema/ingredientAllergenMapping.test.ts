import { describe, expect, it } from "vitest";
import {
  IngredientAllergenMappingSchema,
  VerificationStatusSchema,
} from "./ingredientAllergenMapping.js";

describe("IngredientAllergenMappingSchema", () => {
  it("parses a valid verified fixture", () => {
    const fixture = {
      ingredient_id: "lax",
      allergens: ["fish"],
      verification_status: "verified",
    };

    expect(IngredientAllergenMappingSchema.parse(fixture)).toEqual(fixture);
  });

  it("parses a valid unverified fixture", () => {
    const fixture = {
      ingredient_id: "potatis",
      allergens: [],
      verification_status: "unverified",
    };

    expect(IngredientAllergenMappingSchema.parse(fixture)).toEqual(fixture);
  });

  it("accepts every locked allergen value in a single row", () => {
    const fixture = {
      ingredient_id: "kitchen-sink",
      allergens: [
        "gluten",
        "dairy_lactose",
        "egg",
        "tree_nuts",
        "peanuts",
        "shellfish",
        "fish",
        "soy",
      ],
      verification_status: "verified",
    };

    expect(IngredientAllergenMappingSchema.safeParse(fixture).success).toBe(true);
  });

  it("allows an empty allergens array as a positive 'contains none' claim", () => {
    const fixture = {
      ingredient_id: "gul-lok",
      allergens: [],
      verification_status: "verified",
    };

    expect(IngredientAllergenMappingSchema.safeParse(fixture).success).toBe(true);
  });

  it("rejects an allergen value outside the locked enum", () => {
    const fixture = {
      ingredient_id: "hasselnotter",
      allergens: ["sesame"],
      verification_status: "verified",
    };

    expect(IngredientAllergenMappingSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects duplicate values within allergens", () => {
    const fixture = {
      ingredient_id: "raka",
      allergens: ["shellfish", "shellfish"],
      verification_status: "verified",
    };

    expect(IngredientAllergenMappingSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects a malformed ingredient_id slug", () => {
    const fixture = {
      ingredient_id: "Gul Lök",
      allergens: [],
      verification_status: "verified",
    };

    expect(IngredientAllergenMappingSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects a missing verification_status", () => {
    const fixture = {
      ingredient_id: "gul-lok",
      allergens: [],
    };

    expect(IngredientAllergenMappingSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects a verification_status value outside unverified/verified", () => {
    const fixture = {
      ingredient_id: "gul-lok",
      allergens: [],
      verification_status: "pending",
    };

    expect(IngredientAllergenMappingSchema.safeParse(fixture).success).toBe(false);
  });

  it("treats 'may contain' cases as ordinary containment, not a distinct state", () => {
    // Cross-contamination cases (e.g. oats and gluten) are represented by
    // including the allergen in allergens[] like any definite case — there
    // is no separate "may_contain" value anywhere in the schema.
    const mayContainOats = {
      ingredient_id: "havregryn",
      allergens: ["gluten"],
      verification_status: "verified",
    };

    expect(IngredientAllergenMappingSchema.safeParse(mayContainOats).success).toBe(true);
    expect(VerificationStatusSchema.options).toEqual(["unverified", "verified"]);
  });
});

describe("VerificationStatusSchema", () => {
  it("distinguishes unverified rows from verified rows", () => {
    expect(VerificationStatusSchema.safeParse("unverified").success).toBe(true);
    expect(VerificationStatusSchema.safeParse("verified").success).toBe(true);
    expect(VerificationStatusSchema.safeParse("unverified").data).not.toEqual(
      VerificationStatusSchema.safeParse("verified").data,
    );
  });

  it("rejects a value outside the locked enum", () => {
    expect(VerificationStatusSchema.safeParse("reviewed").success).toBe(false);
  });
});
