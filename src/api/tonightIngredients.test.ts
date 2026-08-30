import { describe, expect, it } from "vitest";
import { makeEngineData, makeIngredient, makeSlot, makeTemplate } from "../engine/__fixtures__/engineData.js";
import { REFERENCE_PORTIONS } from "../engine/quantities.js";
import { buildTonightIngredients } from "./tonightIngredients.js";

describe("buildTonightIngredients", () => {
  it("resolves the curated Swedish name for every slot, in slot order", () => {
    const data = makeEngineData({
      ingredients: [
        makeIngredient("kyckling", { name: "Kyckling" }),
        makeIngredient("potatis", { name: "Potatis" }),
      ],
    });
    const template = makeTemplate("kyckling-gryta", {
      ingredient_slots: [
        makeSlot({ role: "protein", ingredient_id: "kyckling", substitutable: false }),
        makeSlot({ role: "starch", ingredient_id: "potatis", substitutable: true }),
      ],
    });

    const views = buildTonightIngredients(data, { template, substitutions: [] }, REFERENCE_PORTIONS);

    expect(views).toEqual([
      {
        role: "protein",
        name: "Kyckling",
        slotIndex: 0,
        ingredientId: "kyckling",
        substituted: false,
        quantity: { kind: "amount", amount: 100, unit: "g" },
      },
      {
        role: "starch",
        name: "Potatis",
        slotIndex: 1,
        ingredientId: "potatis",
        substituted: false,
        quantity: { kind: "amount", amount: 100, unit: "g" },
      },
    ]);
  });

  it("shows the substituted ingredient's name, not the template's canonical slot ingredient", () => {
    const data = makeEngineData({
      ingredients: [makeIngredient("gul-lok", { name: "Gul lök" }), makeIngredient("rodlok", { name: "Rödlök" })],
    });
    const template = makeTemplate("gryta", {
      ingredient_slots: [makeSlot({ role: "aromatic", ingredient_id: "gul-lok", substitutable: true })],
    });

    const views = buildTonightIngredients(
      data,
      {
        template,
        substitutions: [
          {
            slot_index: 0,
            slot: template.ingredient_slots[0]!,
            substitute_ingredient_id: "rodlok",
          },
        ],
      },
      REFERENCE_PORTIONS,
    );

    expect(views).toEqual([
      {
        role: "aromatic",
        name: "Rödlök",
        slotIndex: 0,
        ingredientId: "rodlok",
        substituted: true,
        // The slot's quantity, not the substitute ingredient's — a swapped slot fills
        // the same hole in the dish (#123).
        quantity: { kind: "amount", amount: 100, unit: "g" },
      },
    ]);
  });

  // #123: the slot carries the amount, so scaling belongs to the diners eating
  // tonight — the same subset `mealDiners` derives constraints from.
  it("scales each slot's quantity to the portion count it is given", () => {
    const data = makeEngineData({
      ingredients: [makeIngredient("kyckling", { name: "Kyckling" })],
    });
    const template = makeTemplate("kycklinggryta", {
      ingredient_slots: [
        {
          role: "protein",
          ingredient_id: "kyckling",
          substitutable: false,
          quantity: { kind: "amount", amount: 600, unit: "g" },
        },
      ],
    });

    const forFour = buildTonightIngredients(data, { template, substitutions: [] }, 4);
    const forTwo = buildTonightIngredients(data, { template, substitutions: [] }, 2);

    expect(forFour[0]!.quantity).toEqual({ kind: "amount", amount: 600, unit: "g" });
    expect(forTwo[0]!.quantity).toEqual({ kind: "amount", amount: 300, unit: "g" });
  });

  it("carries a to_taste slot through unscaled", () => {
    const data = makeEngineData({
      ingredients: [makeIngredient("svartpeppar", { name: "Svartpeppar" })],
    });
    const template = makeTemplate("gryta", {
      ingredient_slots: [
        {
          role: "aromatic",
          ingredient_id: "svartpeppar",
          substitutable: false,
          quantity: { kind: "to_taste" },
        },
      ],
    });

    const views = buildTonightIngredients(data, { template, substitutions: [] }, 8);

    expect(views[0]!.quantity).toEqual({ kind: "to_taste" });
  });

  it("throws rather than emit an empty name when a slot's ingredient id isn't in the catalog", () => {
    const data = makeEngineData({ ingredients: [] });
    const template = makeTemplate("gryta", {
      ingredient_slots: [makeSlot({ role: "protein", ingredient_id: "does-not-exist", substitutable: false })],
    });

    expect(() => buildTonightIngredients(data, { template, substitutions: [] }, REFERENCE_PORTIONS)).toThrow(
      /does-not-exist/,
    );
  });
});

// #223: the variety note, attached to the row the bridge happened on.
describe("buildTonightIngredients — variety notes", () => {
  const ingredients = [
    makeIngredient("matlagningsgradde", { name: "matlagningsgrädde", variety_of: "gradde" }),
    makeIngredient("vispgradde", { name: "vispgrädde", variety_of: "gradde" }),
    makeIngredient("tomat", { name: "tomat", variety_of: "tomat" }),
    makeIngredient("korsbarstomat", { name: "körsbärstomat", variety_of: "tomat" }),
  ];
  const varietyFamilies = [
    { id: "gradde", name: "Grädde", note: "Fetthalten skiljer mellan sorterna." },
    // A family with no note is the normal case and must render nothing extra.
    { id: "tomat", name: "Tomat" },
  ];
  const template = makeTemplate("gryta", {
    ingredient_slots: [
      makeSlot({ role: "dairy", ingredient_id: "matlagningsgradde", substitutable: true }),
      makeSlot({ role: "vegetable", ingredient_id: "tomat", substitutable: true }),
    ],
  });

  function build(pantryCoverage: { ingredientId: string; pantryIngredientId: string }[]) {
    const data = makeEngineData({ ingredients, varietyFamilies });
    return buildTonightIngredients(
      data,
      { template, substitutions: [] },
      REFERENCE_PORTIONS,
      pantryCoverage,
    );
  }

  it("carries the family note on a row covered by a different variety", () => {
    const views = build([{ ingredientId: "matlagningsgradde", pantryIngredientId: "vispgradde" }]);

    expect(views[0]!.varietyNote).toBe("Fetthalten skiljer mellan sorterna.");
  });

  it("omits the key entirely on an exact pantry match", () => {
    // The household marked the very thing the dish names — there is nothing to warn
    // about, and the row must serialize without the key rather than with undefined.
    const views = build([
      { ingredientId: "matlagningsgradde", pantryIngredientId: "matlagningsgradde" },
    ]);

    expect(views[0]).not.toHaveProperty("varietyNote");
  });

  it("omits it when the bridged family has no note", () => {
    const views = build([{ ingredientId: "tomat", pantryIngredientId: "korsbarstomat" }]);

    expect(views[1]).not.toHaveProperty("varietyNote");
  });

  it("omits it on every row with no pantry coverage at all", () => {
    const views = build([]);

    expect(views.every((view) => !("varietyNote" in view))).toBe(true);
  });

  it("attaches the note only to the row that was bridged", () => {
    const views = build([{ ingredientId: "matlagningsgradde", pantryIngredientId: "vispgradde" }]);

    expect(views[1]).not.toHaveProperty("varietyNote");
  });
});
