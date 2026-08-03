import { describe, expect, it } from "vitest";
import { makeEngineData, makeIngredient, makeTemplate } from "../engine/__fixtures__/engineData.js";
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
        { role: "protein", ingredient_id: "kyckling", substitutable: false },
        { role: "starch", ingredient_id: "potatis", substitutable: true },
      ],
    });

    const views = buildTonightIngredients(data, { template, substitutions: [] });

    expect(views).toEqual([
      { role: "protein", name: "Kyckling", substituted: false },
      { role: "starch", name: "Potatis", substituted: false },
    ]);
  });

  it("shows the substituted ingredient's name, not the template's canonical slot ingredient", () => {
    const data = makeEngineData({
      ingredients: [makeIngredient("gul-lok", { name: "Gul lök" }), makeIngredient("rodlok", { name: "Rödlök" })],
    });
    const template = makeTemplate("gryta", {
      ingredient_slots: [{ role: "aromatic", ingredient_id: "gul-lok", substitutable: true }],
    });

    const views = buildTonightIngredients(data, {
      template,
      substitutions: [
        {
          slot_index: 0,
          slot: template.ingredient_slots[0]!,
          substitute_ingredient_id: "rodlok",
        },
      ],
    });

    expect(views).toEqual([{ role: "aromatic", name: "Rödlök", substituted: true }]);
  });

  it("throws rather than emit an empty name when a slot's ingredient id isn't in the catalog", () => {
    const data = makeEngineData({ ingredients: [] });
    const template = makeTemplate("gryta", {
      ingredient_slots: [{ role: "protein", ingredient_id: "does-not-exist", substitutable: false }],
    });

    expect(() => buildTonightIngredients(data, { template, substitutions: [] })).toThrow(
      /does-not-exist/,
    );
  });
});
