import { describe, expect, it } from "vitest";
import { HouseholdSchema } from "./household.js";

describe("HouseholdSchema", () => {
  it("parses a valid household", () => {
    const fixture = {
      members: [
        { type: "adult", portion_factor: 1 },
        { type: "child", portion_factor: 0.6 },
      ],
      allergies: ["gluten", "fish"],
      dietary_flags: ["vegetarian"],
    };

    expect(HouseholdSchema.parse(fixture)).toEqual(fixture);
  });

  it("parses a household with no restrictions", () => {
    const fixture = {
      members: [{ type: "adult", portion_factor: 1 }],
      allergies: [],
      dietary_flags: [],
    };

    expect(HouseholdSchema.safeParse(fixture).success).toBe(true);
  });

  it("rejects a household with no members", () => {
    const result = HouseholdSchema.safeParse({ members: [], allergies: [], dietary_flags: [] });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["members"] });
  });

  it("rejects a member type outside adult/child", () => {
    const result = HouseholdSchema.safeParse({
      members: [{ type: "teenager", portion_factor: 1 }],
      allergies: [],
      dietary_flags: [],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["members", 0, "type"] });
  });

  it("rejects a non-positive portion_factor", () => {
    const result = HouseholdSchema.safeParse({
      members: [{ type: "adult", portion_factor: 0 }],
      allergies: [],
      dietary_flags: [],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["members", 0, "portion_factor"] });
  });

  it("rejects an allergy outside the locked §5.2 vocabulary", () => {
    const result = HouseholdSchema.safeParse({
      members: [{ type: "adult", portion_factor: 1 }],
      allergies: ["sesame"],
      dietary_flags: [],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["allergies", 0] });
  });

  it("rejects a dietary flag outside the locked §5.2 vocabulary", () => {
    const result = HouseholdSchema.safeParse({
      members: [{ type: "adult", portion_factor: 1 }],
      allergies: [],
      dietary_flags: ["pescatarian"],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["dietary_flags", 0] });
  });

  it("rejects duplicate allergies", () => {
    const result = HouseholdSchema.safeParse({
      members: [{ type: "adult", portion_factor: 1 }],
      allergies: ["gluten", "gluten"],
      dietary_flags: [],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]!.message).toContain("must not contain duplicate values");
  });

  it("rejects duplicate dietary flags", () => {
    const result = HouseholdSchema.safeParse({
      members: [{ type: "adult", portion_factor: 1 }],
      allergies: [],
      dietary_flags: ["vegan", "vegan"],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]!.message).toContain("must not contain duplicate values");
  });
});
