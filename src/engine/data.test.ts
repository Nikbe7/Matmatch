import { describe, expect, it } from "vitest";
import { loadEngineData } from "./data.js";

const data = await loadEngineData();

describe("loadEngineData", () => {
  it("loads the four curated data files", () => {
    expect(data.ingredientsById.size).toBe(206);
    expect(data.allergenMappingByIngredientId.size).toBe(206);
    expect(data.templates.length).toBe(170);
    expect(data.substitutionGroupsById.size).toBe(41);
  });

  it("indexes ingredients and templates by their slug id", () => {
    expect(data.ingredientsById.get("agg")?.name).toBe("ägg");
    expect(data.allergenMappingByIngredientId.get("agg")?.allergens).toEqual(["egg"]);
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
});
