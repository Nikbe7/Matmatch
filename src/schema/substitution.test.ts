import { describe, expect, it } from "vitest";
import { SubstitutionGroupSchema } from "./substitution.js";

describe("SubstitutionGroupSchema", () => {
  it("parses a valid group", () => {
    const fixture = {
      id: "lok",
      name: "Lök",
      role: "aromatic",
      member_ingredient_ids: ["gul-lok", "rodlok", "schalottenlok"],
    };

    expect(SubstitutionGroupSchema.parse(fixture)).toEqual(fixture);
  });

  it("accepts the minimum of exactly 2 members", () => {
    const fixture = {
      id: "vit-fisk",
      name: "Vit fisk",
      role: "protein",
      member_ingredient_ids: ["torsk", "sej"],
    };

    expect(SubstitutionGroupSchema.safeParse(fixture).success).toBe(true);
  });

  it("rejects a group with fewer than 2 members", () => {
    const result = SubstitutionGroupSchema.safeParse({
      id: "lok",
      name: "Lök",
      role: "aromatic",
      member_ingredient_ids: ["gul-lok"],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["member_ingredient_ids"] });
  });

  it("rejects a duplicate member within a group", () => {
    const result = SubstitutionGroupSchema.safeParse({
      id: "lok",
      name: "Lök",
      role: "aromatic",
      member_ingredient_ids: ["gul-lok", "gul-lok"],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]!.message).toContain("must not contain duplicate values");
  });

  it("rejects a role outside the locked IngredientSlotRole vocabulary", () => {
    const result = SubstitutionGroupSchema.safeParse({
      id: "lok",
      name: "Lök",
      role: "spice_aromatic",
      member_ingredient_ids: ["gul-lok", "rodlok"],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["role"] });
  });

  it("rejects a non-slug id", () => {
    const result = SubstitutionGroupSchema.safeParse({
      id: "Lök Grupp",
      name: "Lök",
      role: "aromatic",
      member_ingredient_ids: ["gul-lok", "rodlok"],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["id"] });
  });

  it("rejects a non-slug member ingredient id", () => {
    const result = SubstitutionGroupSchema.safeParse({
      id: "lok",
      name: "Lök",
      role: "aromatic",
      member_ingredient_ids: ["gul-lok", "Rödlök"],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["member_ingredient_ids", 1] });
  });

  it("rejects an empty name", () => {
    const result = SubstitutionGroupSchema.safeParse({
      id: "lok",
      name: "",
      role: "aromatic",
      member_ingredient_ids: ["gul-lok", "rodlok"],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["name"] });
  });
});
