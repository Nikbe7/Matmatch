import { describe, expect, it } from "vitest";
import { loadEngineData } from "./data.js";

const data = await loadEngineData();

describe("loadEngineData", () => {
  it("loads the three curated data files the engine reads", () => {
    expect(data.ingredientsById.size).toBe(206);
    expect(data.templates.length).toBe(170);
    expect(data.substitutionGroupsById.size).toBe(41);
  });

  it("does not load data/ingredient-allergens.json — the file is kept, unread (#224)", () => {
    // The whole point of decision 2026-08-25's "validerbar men oläst": the 206
    // hand-verified rows stay in the repo and `npm run validate` still checks them,
    // but nothing the engine hands downstream can consult an allergen again. An index
    // reappearing here is how that would quietly come back.
    expect(Object.keys(data)).not.toContain("allergenMappingByIngredientId");
  });

  it("indexes ingredients and templates by their slug id", () => {
    expect(data.ingredientsById.get("agg")?.name).toBe("ägg");
  });

  it("builds a reverse index from ingredient id to the groups containing it", () => {
    for (const group of data.substitutionGroupsById.values()) {
      for (const memberId of group.member_ingredient_ids) {
        expect(data.substitutionGroupsByMemberIngredientId.get(memberId)).toContain(group);
      }
    }
  });

  it("indexes no ingredient that belongs to no group", () => {
    const indexedMembers = [...data.substitutionGroupsByMemberIngredientId.keys()];
    const groupMembers = new Set(
      [...data.substitutionGroupsById.values()].flatMap((group) => group.member_ingredient_ids),
    );

    expect(indexedMembers.sort()).toEqual([...groupMembers].sort());
  });

  it("rejects a data directory that does not exist rather than returning empty indexes", async () => {
    await expect(loadEngineData("src/engine/__fixtures__/nonexistent")).rejects.toThrow();
  });

  it("gives every template a valid familiarity value, with a sizable everyday pool", () => {
    const byFamiliarity = { everyday: 0, occasional: 0, adventurous: 0 };
    for (const template of data.templates) {
      expect(["everyday", "occasional", "adventurous"]).toContain(template.familiarity);
      byFamiliarity[template.familiarity] += 1;
    }

    // The floor that keeps the everyday pool from being quietly emptied out —
    // see DECISION_LOG for the familiarity classification pass.
    expect(byFamiliarity.everyday).toBeGreaterThanOrEqual(60);
  });

  it("never tags a pancake, waffle, raggmunk or sandwich template as dinner", () => {
    // Cheap guard against the class of dish the meal_types dinner-bar tightening
    // removed (see DECISION_LOG) reappearing in a future template batch.
    const offenders = data.templates.filter(
      (template) =>
        /pannkak|våffl|raggmunk|macka/i.test(template.name) &&
        template.meal_types.includes("dinner"),
    );

    expect(offenders).toEqual([]);
  });
});
