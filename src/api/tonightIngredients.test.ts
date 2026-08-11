import { describe, expect, it } from "vitest";
import { makeEngineData, makeIngredient, makeSlot, makeTemplate } from "../engine/__fixtures__/engineData.js";
import { AllergySchema } from "../schema/allergyDietary.js";
import type { HouseholdMember } from "../schema/household.js";
import { REFERENCE_PORTIONS } from "../engine/quantities.js";
import { buildTonightIngredients } from "./tonightIngredients.js";

function member(overrides: Partial<HouseholdMember> = {}): HouseholdMember {
  return { type: "adult", portion_factor: 1, allergies: [], dietary_flags: [], ...overrides };
}

describe("buildTonightIngredients", () => {
  it("resolves the curated Swedish name for every slot, in slot order", () => {
    const data = makeEngineData({
      ingredients: [
        makeIngredient("kyckling", { name: "Kyckling" }),
        makeIngredient("potatis", { name: "Potatis" }),
      ],
      allergenMappings: [
        { ingredient_id: "kyckling", allergens: [], verification_status: "verified" },
        { ingredient_id: "potatis", allergens: [], verification_status: "verified" },
      ],
    });
    const template = makeTemplate("kyckling-gryta", {
      ingredient_slots: [
        makeSlot({ role: "protein", ingredient_id: "kyckling", substitutable: false }),
        makeSlot({ role: "starch", ingredient_id: "potatis", substitutable: true }),
      ],
    });

    const views = buildTonightIngredients(data, { template, substitutions: [] }, [], REFERENCE_PORTIONS);

    expect(views).toEqual([
      {
        role: "protein",
        name: "Kyckling",
        substituted: false,
        allergens: [],
        quantity: { kind: "amount", amount: 100, unit: "g" },
      },
      {
        role: "starch",
        name: "Potatis",
        substituted: false,
        allergens: [],
        quantity: { kind: "amount", amount: 100, unit: "g" },
      },
    ]);
  });

  it("shows the substituted ingredient's name, not the template's canonical slot ingredient", () => {
    const data = makeEngineData({
      ingredients: [makeIngredient("gul-lok", { name: "Gul lök" }), makeIngredient("rodlok", { name: "Rödlök" })],
      allergenMappings: [
        { ingredient_id: "gul-lok", allergens: [], verification_status: "verified" },
        { ingredient_id: "rodlok", allergens: [], verification_status: "verified" },
      ],
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
      [],
      REFERENCE_PORTIONS,
    );

    expect(views).toEqual([
      {
        role: "aromatic",
        name: "Rödlök",
        substituted: true,
        allergens: [],
        // The slot's quantity, not the substitute ingredient's — a rescued slot fills
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
      allergenMappings: [
        { ingredient_id: "kyckling", allergens: [], verification_status: "verified" },
      ],
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

    const forFour = buildTonightIngredients(data, { template, substitutions: [] }, [], 4);
    const forTwo = buildTonightIngredients(data, { template, substitutions: [] }, [], 2);

    expect(forFour[0]!.quantity).toEqual({ kind: "amount", amount: 600, unit: "g" });
    expect(forTwo[0]!.quantity).toEqual({ kind: "amount", amount: 300, unit: "g" });
  });

  it("carries a to_taste slot through unscaled", () => {
    const data = makeEngineData({
      ingredients: [makeIngredient("svartpeppar", { name: "Svartpeppar" })],
      allergenMappings: [
        { ingredient_id: "svartpeppar", allergens: [], verification_status: "verified" },
      ],
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

    const views = buildTonightIngredients(data, { template, substitutions: [] }, [], 8);

    expect(views[0]!.quantity).toEqual({ kind: "to_taste" });
  });

  it("throws rather than emit an empty name when a slot's ingredient id isn't in the catalog", () => {
    const data = makeEngineData({ ingredients: [] });
    const template = makeTemplate("gryta", {
      ingredient_slots: [makeSlot({ role: "protein", ingredient_id: "does-not-exist", substitutable: false })],
    });

    expect(() => buildTonightIngredients(data, { template, substitutions: [] }, [], REFERENCE_PORTIONS)).toThrow(
      /does-not-exist/,
    );
  });

  // #116: allergen marking is against the full household union, resolved through
  // effectiveAllergens exactly like filtering — never a second rule.
  describe("allergen marking", () => {
    const data = makeEngineData({
      ingredients: [
        makeIngredient("mjolk", { name: "Mjölk" }),
        makeIngredient("morot", { name: "Morot" }),
        makeIngredient("overifierad-ingrediens", { name: "Okänd" }),
      ],
      allergenMappings: [
        { ingredient_id: "mjolk", allergens: ["dairy_lactose"], verification_status: "verified" },
        { ingredient_id: "morot", allergens: [], verification_status: "verified" },
        // Deliberately no verified row — exercises the §5.4 fail-safe path.
        { ingredient_id: "overifierad-ingrediens", allergens: [], verification_status: "unverified" },
      ],
    });

    function template(ingredientId: string) {
      return makeTemplate("t", {
        ingredient_slots: [makeSlot({ role: "protein", ingredient_id: ingredientId, substitutable: false })],
      });
    }

    it("marks an ingredient carrying an allergen a household member declared, naming them", () => {
      const members = [member({ name: "Elsa", allergies: ["dairy_lactose"] })];

      const [view] = buildTonightIngredients(data, { template: template("mjolk"), substitutions: [] }, members, REFERENCE_PORTIONS);

      expect(view!.allergens).toEqual([{ allergy: "dairy_lactose", members: ["Elsa"] }]);
    });

    it("does not mark an ingredient carrying an allergen nobody declared", () => {
      const members = [member({ allergies: ["fish"] })];

      const [view] = buildTonightIngredients(data, { template: template("mjolk"), substitutions: [] }, members, REFERENCE_PORTIONS);

      expect(view!.allergens).toEqual([]);
    });

    it("does not mark an ingredient with no allergens against a household with declared allergies", () => {
      const members = [member({ allergies: ["dairy_lactose"] })];

      const [view] = buildTonightIngredients(data, { template: template("morot"), substitutions: [] }, members, REFERENCE_PORTIONS);

      expect(view!.allergens).toEqual([]);
    });

    it("falls back to the derived label when the member has no name", () => {
      const members = [member({ allergies: ["dairy_lactose"] })];

      const [view] = buildTonightIngredients(data, { template: template("mjolk"), substitutions: [] }, members, REFERENCE_PORTIONS);

      expect(view!.allergens).toEqual([{ allergy: "dairy_lactose", members: ["Vuxen 1"] }]);
    });

    it("names every member who shares the declared allergy", () => {
      const members = [
        member({ name: "Elsa", allergies: ["dairy_lactose"] }),
        member({ name: "Sam", allergies: ["dairy_lactose"] }),
      ];

      const [view] = buildTonightIngredients(data, { template: template("mjolk"), substitutions: [] }, members, REFERENCE_PORTIONS);

      expect(view!.allergens).toEqual([{ allergy: "dairy_lactose", members: ["Elsa", "Sam"] }]);
    });

    it("marking is independent of any diner set — deselecting the allergic member changes nothing", () => {
      // buildTonightIngredients takes the full household member list, never a diner
      // subset — there is no diner parameter to pass here at all, which is the point:
      // a diner-scoped caller would have to explicitly narrow `members` itself, and
      // this module gives it no such argument to narrow with.
      const wholeHousehold = [
        member({ name: "Elsa", allergies: ["dairy_lactose"] }),
        member({ name: "Pappa", allergies: [] }),
      ];

      const [view] = buildTonightIngredients(
        data,
        { template: template("mjolk"), substitutions: [] },
        wholeHousehold,
        REFERENCE_PORTIONS,
      );

      expect(view!.allergens).toEqual([{ allergy: "dairy_lactose", members: ["Elsa"] }]);
    });

    it.each(AllergySchema.options)(
      "marks an unverified row against a household that declared %s, never against one that didn't",
      (allergy) => {
        const declaring = [member({ name: "Elsa", allergies: [allergy] })];
        const [markedView] = buildTonightIngredients(
          data,
          { template: template("overifierad-ingrediens"), substitutions: [] },
          declaring,
          REFERENCE_PORTIONS,
        );
        expect(markedView!.allergens).toEqual([{ allergy, members: ["Elsa"] }]);

        const other = AllergySchema.options.find((candidate) => candidate !== allergy)!;
        const notDeclaring = [member({ name: "Sam", allergies: [other] })];
        const [unmarkedView] = buildTonightIngredients(
          data,
          { template: template("overifierad-ingrediens"), substitutions: [] },
          notDeclaring,
          REFERENCE_PORTIONS,
        );
        expect(unmarkedView!.allergens).toEqual([{ allergy: other, members: ["Sam"] }]);
        expect(unmarkedView!.allergens.some((marking) => marking.allergy === allergy)).toBe(false);
      },
    );

    it("marks nothing for an unverified row against a household with no declared allergies", () => {
      const [view] = buildTonightIngredients(
        data,
        { template: template("overifierad-ingrediens"), substitutions: [] },
        [member()],
        REFERENCE_PORTIONS,
      );

      expect(view!.allergens).toEqual([]);
    });
  });
});
