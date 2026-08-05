import { describe, expect, it } from "vitest";
import {
  CuisineSchema,
  FamiliaritySchema,
  IngredientSlotRoleSchema,
  MealTypeSchema,
  PrepTimeBandSchema,
  ProteinGroupSchema,
  RecipeTemplateSchema,
} from "./recipeTemplate.js";

describe("RecipeTemplateSchema", () => {
  it("parses a valid fixture", () => {
    const fixture = {
      id: "kycklinggryta-med-curry",
      name: "Kycklinggryta med curry",
      protein_group: "chicken_poultry",
      cuisine: "asian",
      cost_tier: "mid",
      prep_time_band: "20-40min",
      dietary_tags: [],
      meal_types: ["dinner"],
      familiarity: "everyday",
      ingredient_slots: [
        { role: "protein", ingredient_id: "ing_010", substitutable: true },
        { role: "starch", ingredient_id: "ing_020", substitutable: false },
        { role: "aromatic", ingredient_id: "ing_030", substitutable: true },
      ],
    };

    expect(RecipeTemplateSchema.parse(fixture)).toEqual(fixture);
  });

  it("allows zero or more dietary_tags", () => {
    const fixture = {
      id: "vegetarisk-linsgryta",
      name: "Vegetarisk linsgryta",
      protein_group: "vegetarian_vegan",
      cuisine: "middle_eastern",
      cost_tier: "budget",
      prep_time_band: "40min+",
      dietary_tags: ["vegetarian", "vegan"],
      meal_types: ["lunch", "dinner"],
      familiarity: "everyday",
      ingredient_slots: [
        { role: "protein", ingredient_id: "ing_040", substitutable: true },
      ],
    };

    expect(RecipeTemplateSchema.parse(fixture)).toEqual(fixture);
  });

  it("rejects an empty ingredient_slots array", () => {
    const fixture = {
      id: "tomt-recept",
      name: "Tomt recept",
      protein_group: "egg_dairy_pantry",
      cuisine: "swedish_nordic",
      cost_tier: "budget",
      prep_time_band: "<20min",
      dietary_tags: [],
      meal_types: ["dinner"],
      familiarity: "everyday",
      ingredient_slots: [],
    };

    expect(RecipeTemplateSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects an id containing åäö", () => {
    const fixture = {
      id: "kycklinggryta-med-currysås",
      name: "Kycklinggryta med currysås",
      protein_group: "chicken_poultry",
      cuisine: "asian",
      cost_tier: "mid",
      prep_time_band: "20-40min",
      dietary_tags: [],
      meal_types: ["dinner"],
      familiarity: "everyday",
      ingredient_slots: [
        { role: "protein", ingredient_id: "ing_010", substitutable: true },
      ],
    };

    expect(RecipeTemplateSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects a template missing meal_types entirely, rather than defaulting to dinner", () => {
    const fixture = {
      id: "recept-utan-maltid",
      name: "Recept utan måltid",
      protein_group: "egg_dairy_pantry",
      cuisine: "swedish_nordic",
      cost_tier: "budget",
      prep_time_band: "<20min",
      dietary_tags: [],
      familiarity: "everyday",
      ingredient_slots: [{ role: "protein", ingredient_id: "ing_050", substitutable: true }],
    };

    expect(RecipeTemplateSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects duplicate meal_types", () => {
    const fixture = {
      id: "recept-med-dubblett",
      name: "Recept med dubblett",
      protein_group: "egg_dairy_pantry",
      cuisine: "swedish_nordic",
      cost_tier: "budget",
      prep_time_band: "<20min",
      dietary_tags: [],
      meal_types: ["dinner", "dinner"],
      familiarity: "everyday",
      ingredient_slots: [{ role: "protein", ingredient_id: "ing_050", substitutable: true }],
    };

    const result = RecipeTemplateSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]!.message).toContain("must not contain duplicate values");
  });

  it("rejects a template missing familiarity entirely, rather than defaulting to everyday", () => {
    const fixture = {
      id: "recept-utan-familiarity",
      name: "Recept utan familiarity",
      protein_group: "egg_dairy_pantry",
      cuisine: "swedish_nordic",
      cost_tier: "budget",
      prep_time_band: "<20min",
      dietary_tags: [],
      meal_types: ["dinner"],
      ingredient_slots: [{ role: "protein", ingredient_id: "ing_050", substitutable: true }],
    };

    const result = RecipeTemplateSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]!.path).toEqual(["familiarity"]);
  });

  it("rejects a familiarity value outside the locked enum", () => {
    const fixture = {
      id: "recept-med-ogiltig-familiarity",
      name: "Recept med ogiltig familiarity",
      protein_group: "egg_dairy_pantry",
      cuisine: "swedish_nordic",
      cost_tier: "budget",
      prep_time_band: "<20min",
      dietary_tags: [],
      meal_types: ["dinner"],
      familiarity: "exotic",
      ingredient_slots: [{ role: "protein", ingredient_id: "ing_050", substitutable: true }],
    };

    expect(RecipeTemplateSchema.safeParse(fixture).success).toBe(false);
  });

  it.each(FamiliaritySchema.options)("accepts familiarity value %s", (familiarity) => {
    const fixture = {
      id: "recept-med-familiarity",
      name: "Recept med familiarity",
      protein_group: "egg_dairy_pantry",
      cuisine: "swedish_nordic",
      cost_tier: "budget",
      prep_time_band: "<20min",
      dietary_tags: [],
      meal_types: ["dinner"],
      familiarity,
      ingredient_slots: [{ role: "protein", ingredient_id: "ing_050", substitutable: true }],
    };

    expect(RecipeTemplateSchema.safeParse(fixture).success).toBe(true);
  });
});

describe("MealTypeSchema", () => {
  it("rejects a value outside the locked enum", () => {
    expect(MealTypeSchema.safeParse("brunch").success).toBe(false);
  });
});

describe("FamiliaritySchema", () => {
  it("rejects a value outside the locked enum", () => {
    expect(FamiliaritySchema.safeParse("exotic").success).toBe(false);
  });

  it("has exactly the three locked values", () => {
    expect(FamiliaritySchema.options).toEqual(["everyday", "occasional", "adventurous"]);
  });
});

describe("ProteinGroupSchema", () => {
  it("rejects a value outside the locked enum", () => {
    expect(ProteinGroupSchema.safeParse("lamb").success).toBe(false);
  });
});

describe("CuisineSchema", () => {
  it("rejects a value outside the locked enum", () => {
    expect(CuisineSchema.safeParse("french").success).toBe(false);
  });
});

describe("PrepTimeBandSchema", () => {
  it("rejects a value outside the locked enum", () => {
    expect(PrepTimeBandSchema.safeParse("60min+").success).toBe(false);
  });
});

describe("IngredientSlotRoleSchema", () => {
  it("rejects the raw ingredient-category string spice_aromatic", () => {
    // Slot role uses "aromatic", not the Ingredient.category value "spice_aromatic" —
    // the two vocabularies are intentionally distinct (see recipeTemplate.ts).
    expect(IngredientSlotRoleSchema.safeParse("spice_aromatic").success).toBe(false);
  });
});
