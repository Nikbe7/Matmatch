import { describe, expect, it } from "vitest";
import {
  CuisineSchema,
  FamiliaritySchema,
  IngredientSlotRoleSchema,
  IngredientSlotSchema,
  MealTypeSchema,
  PrepTimeBandSchema,
  ProteinGroupSchema,
  QuantityUnitSchema,
  RecipeTemplateSchema,
} from "./recipeTemplate.js";

describe("RecipeTemplateSchema", () => {
  it("parses a valid fixture", () => {
    const fixture = {
      id: "kycklinggryta-med-curry",
      name: "Kycklinggryta med curry",
      blurb: "Testblurb för kycklinggryta med curry.",
      protein_group: "chicken_poultry",
      cuisine: "asian",
      cost_tier: "mid",
      prep_time_band: "20-40min",
      dietary_tags: [],
      meal_types: ["dinner"],
      familiarity: "everyday",
      ingredient_slots: [
        { role: "protein", ingredient_id: "ing_010", substitutable: true, quantity: { kind: "amount", amount: 400, unit: "g" } },
        { role: "starch", ingredient_id: "ing_020", substitutable: false, quantity: { kind: "amount", amount: 400, unit: "g" } },
        { role: "aromatic", ingredient_id: "ing_030", substitutable: true, quantity: { kind: "amount", amount: 400, unit: "g" } },
      ],
    };

    expect(RecipeTemplateSchema.parse(fixture)).toEqual(fixture);
  });

  it("allows zero or more dietary_tags", () => {
    const fixture = {
      id: "vegetarisk-linsgryta",
      name: "Vegetarisk linsgryta",
      blurb: "Testblurb för vegetarisk linsgryta.",
      protein_group: "vegetarian_vegan",
      cuisine: "middle_eastern",
      cost_tier: "budget",
      prep_time_band: "40min+",
      dietary_tags: ["vegetarian", "vegan"],
      meal_types: ["lunch", "dinner"],
      familiarity: "everyday",
      ingredient_slots: [
        { role: "protein", ingredient_id: "ing_040", substitutable: true, quantity: { kind: "amount", amount: 400, unit: "g" } },
      ],
    };

    expect(RecipeTemplateSchema.parse(fixture)).toEqual(fixture);
  });

  it("rejects an empty ingredient_slots array", () => {
    const fixture = {
      id: "tomt-recept",
      name: "Tomt recept",
      blurb: "Testblurb för tomt recept.",
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
      blurb: "Testblurb för kycklinggryta med currysås.",
      protein_group: "chicken_poultry",
      cuisine: "asian",
      cost_tier: "mid",
      prep_time_band: "20-40min",
      dietary_tags: [],
      meal_types: ["dinner"],
      familiarity: "everyday",
      ingredient_slots: [
        { role: "protein", ingredient_id: "ing_010", substitutable: true, quantity: { kind: "amount", amount: 400, unit: "g" } },
      ],
    };

    expect(RecipeTemplateSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects a template missing meal_types entirely, rather than defaulting to dinner", () => {
    const fixture = {
      id: "recept-utan-maltid",
      name: "Recept utan måltid",
      blurb: "Testblurb för recept utan måltid.",
      protein_group: "egg_dairy_pantry",
      cuisine: "swedish_nordic",
      cost_tier: "budget",
      prep_time_band: "<20min",
      dietary_tags: [],
      familiarity: "everyday",
      ingredient_slots: [{ role: "protein", ingredient_id: "ing_050", substitutable: true, quantity: { kind: "amount", amount: 400, unit: "g" } }],
    };

    expect(RecipeTemplateSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects duplicate meal_types", () => {
    const fixture = {
      id: "recept-med-dubblett",
      name: "Recept med dubblett",
      blurb: "Testblurb för recept med dubblett.",
      protein_group: "egg_dairy_pantry",
      cuisine: "swedish_nordic",
      cost_tier: "budget",
      prep_time_band: "<20min",
      dietary_tags: [],
      meal_types: ["dinner", "dinner"],
      familiarity: "everyday",
      ingredient_slots: [{ role: "protein", ingredient_id: "ing_050", substitutable: true, quantity: { kind: "amount", amount: 400, unit: "g" } }],
    };

    const result = RecipeTemplateSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]!.message).toContain("must not contain duplicate values");
  });

  it("rejects a template missing familiarity entirely, rather than defaulting to everyday", () => {
    const fixture = {
      id: "recept-utan-familiarity",
      name: "Recept utan familiarity",
      blurb: "Testblurb för recept utan familiarity.",
      protein_group: "egg_dairy_pantry",
      cuisine: "swedish_nordic",
      cost_tier: "budget",
      prep_time_band: "<20min",
      dietary_tags: [],
      meal_types: ["dinner"],
      ingredient_slots: [{ role: "protein", ingredient_id: "ing_050", substitutable: true, quantity: { kind: "amount", amount: 400, unit: "g" } }],
    };

    const result = RecipeTemplateSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]!.path).toEqual(["familiarity"]);
  });

  it("rejects a familiarity value outside the locked enum", () => {
    const fixture = {
      id: "recept-med-ogiltig-familiarity",
      name: "Recept med ogiltig familiarity",
      blurb: "Testblurb för recept med ogiltig familiarity.",
      protein_group: "egg_dairy_pantry",
      cuisine: "swedish_nordic",
      cost_tier: "budget",
      prep_time_band: "<20min",
      dietary_tags: [],
      meal_types: ["dinner"],
      familiarity: "exotic",
      ingredient_slots: [{ role: "protein", ingredient_id: "ing_050", substitutable: true, quantity: { kind: "amount", amount: 400, unit: "g" } }],
    };

    expect(RecipeTemplateSchema.safeParse(fixture).success).toBe(false);
  });

  it.each(FamiliaritySchema.options)("accepts familiarity value %s", (familiarity) => {
    const fixture = {
      id: "recept-med-familiarity",
      name: "Recept med familiarity",
      blurb: "Testblurb för recept med familiarity.",
      protein_group: "egg_dairy_pantry",
      cuisine: "swedish_nordic",
      cost_tier: "budget",
      prep_time_band: "<20min",
      dietary_tags: [],
      meal_types: ["dinner"],
      familiarity,
      ingredient_slots: [{ role: "protein", ingredient_id: "ing_050", substitutable: true, quantity: { kind: "amount", amount: 400, unit: "g" } }],
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

// #123. The rule these pin is "state an amount or state that there is none" — the
// third possibility, an absent quantity, is what must never parse.
describe("IngredientSlotSchema — quantity", () => {
  function slot(quantity: unknown) {
    return { role: "protein", ingredient_id: "ing_010", substitutable: true, quantity };
  }

  it("rejects a slot with no quantity at all", () => {
    const { quantity, ...withoutQuantity } = slot(undefined);
    void quantity;
    expect(IngredientSlotSchema.safeParse(withoutQuantity).success).toBe(false);
  });

  it("accepts an amount in a unit from the closed vocabulary", () => {
    expect(IngredientSlotSchema.safeParse(slot({ kind: "amount", amount: 600, unit: "g" })).success).toBe(
      true,
    );
  });

  it("accepts the explicit to_taste marker", () => {
    expect(IngredientSlotSchema.safeParse(slot({ kind: "to_taste" })).success).toBe(true);
  });

  it("rejects a unit outside the closed vocabulary", () => {
    expect(IngredientSlotSchema.safeParse(slot({ kind: "amount", amount: 1, unit: "kg" })).success).toBe(
      false,
    );
    expect(IngredientSlotSchema.safeParse(slot({ kind: "amount", amount: 100, unit: "ml" })).success).toBe(
      false,
    );
  });

  it("rejects a zero or negative amount", () => {
    expect(IngredientSlotSchema.safeParse(slot({ kind: "amount", amount: 0, unit: "g" })).success).toBe(
      false,
    );
    expect(IngredientSlotSchema.safeParse(slot({ kind: "amount", amount: -100, unit: "g" })).success).toBe(
      false,
    );
  });

  it("rejects an amount with no unit, and a bare number", () => {
    expect(IngredientSlotSchema.safeParse(slot({ kind: "amount", amount: 400 })).success).toBe(false);
    expect(IngredientSlotSchema.safeParse(slot(400)).success).toBe(false);
  });
});

describe("QuantityUnitSchema", () => {
  it("locks the vocabulary to the eight units a Swedish kitchen uses", () => {
    expect(QuantityUnitSchema.options).toEqual([
      "g",
      "dl",
      "msk",
      "tsk",
      "krm",
      "st",
      "klyfta",
      "kruka",
    ]);
  });
});
