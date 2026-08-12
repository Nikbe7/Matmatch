import { describe, expect, it } from "vitest";
import { ALLERGIES, type Allergy } from "../schema/allergyDietary.js";
import { affectedMemberLabel, explainReplacedDish } from "./dinerChangeReason.js";
import { evaluateTemplateAgainstConstraints } from "../engine/candidates.js";
import { mealConstraints } from "../engine/constraints.js";
import type { HouseholdMember } from "../schema/household.js";
import { makeEngineData, makeIngredient, makeSlot, makeTemplate } from "../engine/__fixtures__/engineData.js";

// #133: naming *who* a replaced dish no longer fits. Exhaustive over the locked
// allergy vocabulary (§5.2) — every allergy must trace back to the member who
// declared it, not just the one this suite happens to pick.

function member(overrides: Partial<HouseholdMember> = {}): HouseholdMember {
  return { type: "adult", portion_factor: 1, allergies: [], dietary_flags: [], ...overrides };
}

describe("affectedMemberLabel", () => {
  const nonSubstitutable = "kyckling";
  const template = makeTemplate("kycklinggryta", {
    ingredient_slots: [makeSlot({ role: "protein", ingredient_id: nonSubstitutable, substitutable: false })],
  });

  it.each(ALLERGIES)("names the eating member whose %s the unrescuable slot conflicts with", (allergy: Allergy) => {
    const data = makeEngineData({
      ingredients: [makeIngredient(nonSubstitutable, { category: "protein" })],
      allergenMappings: [
        { ingredient_id: nonSubstitutable, allergens: [allergy], verification_status: "verified" },
      ],
      templates: [template],
    });
    const clean = member({ name: "Anna" });
    const allergic = member({ name: "Elsa", allergies: [allergy] });
    const members = [clean, allergic];
    const constraints = mealConstraints(members);
    const evaluation = evaluateTemplateAgainstConstraints(data, template, constraints);

    const label = affectedMemberLabel(data, evaluation, constraints, members, members);

    expect(label).toBe("Elsa");
  });

  it("names the affected member for a missing dietary flag", () => {
    const data = makeEngineData({ templates: [template] });
    const omnivore = member({ name: "Anna" });
    const vegan = member({ name: "Elsa", dietary_flags: ["vegan"] });
    const members = [omnivore, vegan];
    const constraints = mealConstraints(members);
    const evaluation = evaluateTemplateAgainstConstraints(data, template, constraints);

    const label = affectedMemberLabel(data, evaluation, constraints, members, members);

    expect(label).toBe("Elsa");
  });

  it("returns undefined when the evaluation was safe — nothing to explain", () => {
    const data = makeEngineData({
      ingredients: [makeIngredient(nonSubstitutable, { category: "protein" })],
      allergenMappings: [
        { ingredient_id: nonSubstitutable, allergens: [], verification_status: "verified" },
      ],
      templates: [template],
    });
    const members = [member({ name: "Anna" })];
    const constraints = mealConstraints(members);
    const evaluation = evaluateTemplateAgainstConstraints(data, template, constraints);

    expect(affectedMemberLabel(data, evaluation, constraints, members, members)).toBeUndefined();
  });

  it("only ever names someone in `eating`, never a household member left off tonight's diner set", () => {
    const data = makeEngineData({
      ingredients: [makeIngredient(nonSubstitutable, { category: "protein" })],
      allergenMappings: [
        { ingredient_id: nonSubstitutable, allergens: ["peanuts"], verification_status: "verified" },
      ],
      templates: [template],
    });
    const clean = member({ name: "Anna" });
    const allergic = member({ name: "Elsa", allergies: ["peanuts"] });
    const members = [clean, allergic];
    // `eating` still includes the allergic member, so the union constraints still
    // exclude the dish — but `affectedMemberLabel` must still resolve to her, not
    // to the member who happens to be first in the roster.
    const eating = members;
    const constraints = mealConstraints(eating);
    const evaluation = evaluateTemplateAgainstConstraints(data, template, constraints);

    expect(affectedMemberLabel(data, evaluation, constraints, members, eating)).toBe("Elsa");
  });

  it("attributes an unverified-mapping exclusion to any eating member with a declared allergy, not just one whose specific allergy happens to match", () => {
    // §5.4's fail-safe: an unverified row is treated as containing every
    // allergen, so `contains` here is the full vocabulary — Elsa's only
    // declared allergy is "fish", nothing to do with the unverified row's real
    // contents, and this must still name her rather than fall silent.
    const data = makeEngineData({
      ingredients: [makeIngredient(nonSubstitutable, { category: "protein" })],
      allergenMappings: [
        { ingredient_id: nonSubstitutable, allergens: [], verification_status: "unverified" },
      ],
      templates: [template],
    });
    const members = [member({ name: "Anna" }), member({ name: "Elsa", allergies: ["fish"] })];
    const constraints = mealConstraints(members);
    const evaluation = evaluateTemplateAgainstConstraints(data, template, constraints);

    expect(affectedMemberLabel(data, evaluation, constraints, members, members)).toBe("Elsa");
  });

  it("never returns undefined once an allergic household is affected, even when no declared allergy is the literal cause", () => {
    // A slot can be unrescuably unsafe for a reason no declared allergy
    // literally caused (a template referencing an ingredient missing from the
    // catalog is excluded outright — allergens.ts's other fail-safe branch).
    // Reachable only in already-corrupt curated data, so this documents the
    // last-resort fallback rather than a state the real catalog can produce.
    const data = makeEngineData({ templates: [template] }); // "kyckling" has no ingredient row
    const members = [member({ name: "Anna" }), member({ name: "Elsa", allergies: ["fish"] })];
    const constraints = mealConstraints(members);
    const evaluation = evaluateTemplateAgainstConstraints(data, template, constraints);

    expect(affectedMemberLabel(data, evaluation, constraints, members, members)).toBe("Elsa");
  });

  it("falls back to the derived label when the member has no name", () => {
    const data = makeEngineData({
      ingredients: [makeIngredient(nonSubstitutable, { category: "protein" })],
      allergenMappings: [
        { ingredient_id: nonSubstitutable, allergens: ["fish"], verification_status: "verified" },
      ],
      templates: [template],
    });
    const members = [member(), member({ type: "child", allergies: ["fish"] })];
    const constraints = mealConstraints(members);
    const evaluation = evaluateTemplateAgainstConstraints(data, template, constraints);

    expect(affectedMemberLabel(data, evaluation, constraints, members, members)).toBe("Barn 1");
  });
});

describe("explainReplacedDish", () => {
  const nonSubstitutable = "kyckling";
  const template = makeTemplate("kycklinggryta", {
    ingredient_slots: [makeSlot({ role: "protein", ingredient_id: nonSubstitutable, substitutable: false })],
  });

  it("resolves the raw template and the affected member from a `keep` id alone", () => {
    const data = makeEngineData({
      ingredients: [makeIngredient(nonSubstitutable, { category: "protein" })],
      allergenMappings: [
        { ingredient_id: nonSubstitutable, allergens: ["peanuts"], verification_status: "verified" },
      ],
      templates: [template],
    });
    const members = [member({ name: "Anna" }), member({ name: "Elsa", allergies: ["peanuts"] })];

    const explanation = explainReplacedDish(data, "kycklinggryta", mealConstraints(members), members, members);

    expect(explanation?.template).toBe(template);
    expect(explanation?.affectedMemberLabel).toBe("Elsa");
  });

  it("returns undefined for a stale or unknown keep id — never invents a 'before' dish", () => {
    const data = makeEngineData({ templates: [template] });
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
      ingredient_slots: [makeSlot({ role: "protein", ingredient_id: nonSubstitutable, substitutable: false })],
    });
    const data = makeEngineData({
      ingredients: [makeIngredient(nonSubstitutable, { category: "protein" })],
      allergenMappings: [
        { ingredient_id: nonSubstitutable, allergens: ["peanuts"], verification_status: "verified" },
      ],
      templates: [lunchOnly],
    });
    const members = [member({ allergies: ["peanuts"] })];

    expect(explainReplacedDish(data, "lunchbowl", mealConstraints(members), members, members)).toBeUndefined();
  });
});
