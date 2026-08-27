import { describe, expect, it } from "vitest";
import { affectedMemberLabel, explainReplacedDish } from "./dinerChangeReason.js";
import { evaluateTemplateAgainstConstraints } from "../engine/candidates.js";
import { mealConstraints } from "../engine/constraints.js";
import type { HouseholdMember } from "../schema/household.js";
import { makeEngineData, makeIngredient, makeSlot, makeTemplate } from "../engine/__fixtures__/engineData.js";

// #133: naming *who* a replaced dish no longer fits. Since #224 a dish can only be
// replaced for a person over a dietary flag — the allergy half of this, and the
// exhaustive sweep over the locked allergy vocabulary that went with it, are gone.

function member(overrides: Partial<HouseholdMember> = {}): HouseholdMember {
  return { type: "adult", portion_factor: 1, dietary_flags: [], ...overrides };
}

const INGREDIENT_ID = "kyckling";
const template = makeTemplate("kycklinggryta", {
  ingredient_slots: [makeSlot({ role: "protein", ingredient_id: INGREDIENT_ID, substitutable: false })],
});
const data = makeEngineData({
  ingredients: [makeIngredient(INGREDIENT_ID, { category: "protein" })],
  templates: [template],
});

function evaluate(eating: readonly HouseholdMember[]) {
  return evaluateTemplateAgainstConstraints(data, template, mealConstraints(eating));
}

describe("affectedMemberLabel", () => {
  it("names the affected member for a missing dietary flag", () => {
    const members = [member({ name: "Anna" }), member({ name: "Elsa", dietary_flags: ["vegan"] })];

    expect(affectedMemberLabel(evaluate(members), members, members)).toBe("Elsa");
  });

  it("names the member for every hard dietary flag, not just the one this suite picks", () => {
    for (const flag of ["vegetarian", "vegan"] as const) {
      const members = [member({ name: "Anna" }), member({ name: "Elsa", dietary_flags: [flag] })];

      expect(affectedMemberLabel(evaluate(members), members, members)).toBe("Elsa");
    }
  });

  it("returns undefined when the evaluation was safe — nothing to explain", () => {
    const members = [member({ name: "Anna" })];

    expect(affectedMemberLabel(evaluate(members), members, members)).toBeUndefined();
  });

  it("only ever names someone in `eating`, never a household member left off tonight's diner set", () => {
    // Anna is first in the roster and her flag matches the failure exactly — but she
    // is not at the table, so the person the copy names has to be Elsa.
    const anna = member({ name: "Anna", dietary_flags: ["vegan"] });
    const elsa = member({ name: "Elsa", dietary_flags: ["vegan"] });
    const members = [anna, elsa];
    const eating = [elsa];

    expect(affectedMemberLabel(evaluate(eating), members, eating)).toBe("Elsa");
  });

  it("names nobody when the catalog cannot resolve the dish's ingredients", () => {
    // The replacement for the old "never returns undefined once an allergic household
    // is affected" fallback, and deliberately the opposite claim (#224). An
    // unresolvable slot is a curated-data fault; naming a person for it would tell a
    // household that someone at their table is the reason a dish disappeared when
    // nobody is. The caller renders a plain replacement with no "for X" clause.
    const emptyCatalog = makeEngineData({ templates: [template] });
    const members = [member({ name: "Anna" }), member({ name: "Elsa" })];
    const evaluation = evaluateTemplateAgainstConstraints(
      emptyCatalog,
      template,
      mealConstraints(members),
    );

    expect(evaluation).toEqual({
      unknownSlotIngredient: { slotIndex: 0, ingredientId: INGREDIENT_ID },
    });
    expect(affectedMemberLabel(evaluation, members, members)).toBeUndefined();
  });

  it("falls back to the derived label when the member has no name", () => {
    const members = [member(), member({ type: "child", dietary_flags: ["vegan"] })];

    expect(affectedMemberLabel(evaluate(members), members, members)).toBe("Barn 1");
  });
});

describe("explainReplacedDish", () => {
  it("resolves the raw template and the affected member from a `keep` id alone", () => {
    const members = [member({ name: "Anna" }), member({ name: "Elsa", dietary_flags: ["vegan"] })];

    const explanation = explainReplacedDish(data, "kycklinggryta", mealConstraints(members), members, members);

    expect(explanation?.template).toBe(template);
    expect(explanation?.affectedMemberLabel).toBe("Elsa");
  });

  it("returns undefined for a stale or unknown keep id — never invents a 'before' dish", () => {
    const members = [member()];

    const explanation = explainReplacedDish(
      data,
      "not-a-real-template",
      mealConstraints(members),
      members,
      members,
    );

    expect(explanation).toBeUndefined();
  });

  it("never resolves a non-dinner template, matching selectCandidateTemplates' own filter", () => {
    const lunchOnly = makeTemplate("lunchbowl", {
      meal_types: ["lunch"],
      ingredient_slots: [makeSlot({ role: "protein", ingredient_id: INGREDIENT_ID, substitutable: false })],
    });
    const lunchData = makeEngineData({
      ingredients: [makeIngredient(INGREDIENT_ID, { category: "protein" })],
      templates: [lunchOnly],
    });
    const members = [member({ dietary_flags: ["vegan"] })];

    expect(
      explainReplacedDish(lunchData, "lunchbowl", mealConstraints(members), members, members),
    ).toBeUndefined();
  });
});
