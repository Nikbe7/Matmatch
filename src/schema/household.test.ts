import { describe, expect, it } from "vitest";
import { HouseholdSchema, MEMBER_NAME_MAX_LENGTH, memberLabels } from "./household.js";

describe("HouseholdSchema", () => {
  it("parses a valid household", () => {
    const fixture = {
      members: [
        { type: "adult", name: "Ella", portion_factor: 1, dietary_flags: ["vegetarian"] },
        { type: "child", portion_factor: 0.6, dietary_flags: [] },
      ],
    };

    expect(HouseholdSchema.parse(fixture)).toEqual(fixture);
  });

  it("parses a household with no restrictions", () => {
    const fixture = {
      members: [{ type: "adult", portion_factor: 1, dietary_flags: [] }],
    };

    expect(HouseholdSchema.safeParse(fixture).success).toBe(true);
  });

  it("rejects a household with no members", () => {
    const result = HouseholdSchema.safeParse({ members: [] });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["members"] });
  });

  it("rejects a member type outside adult/child", () => {
    const result = HouseholdSchema.safeParse({
      members: [{ type: "teenager", portion_factor: 1, dietary_flags: [] }],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["members", 0, "type"] });
  });

  it("rejects a non-positive portion_factor", () => {
    const result = HouseholdSchema.safeParse({
      members: [{ type: "adult", portion_factor: 0, dietary_flags: [] }],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["members", 0, "portion_factor"] });
  });

  it("rejects a dietary flag outside the locked §5.2 vocabulary", () => {
    const result = HouseholdSchema.safeParse({
      members: [{ type: "adult", portion_factor: 1, dietary_flags: ["pescatarian"] }],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["members", 0, "dietary_flags", 0] });
  });

  it("rejects duplicate dietary flags on one member", () => {
    const result = HouseholdSchema.safeParse({
      members: [{ type: "adult", portion_factor: 1, dietary_flags: ["vegan", "vegan"] }],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]!.message).toContain("must not contain duplicate values");
  });

  it("accepts the same dietary flag on two different members — that is a union, not a duplicate", () => {
    const result = HouseholdSchema.safeParse({
      members: [
        { type: "adult", portion_factor: 1, dietary_flags: ["vegan"] },
        { type: "child", portion_factor: 0.5, dietary_flags: ["vegan"] },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("requires dietary_flags rather than defaulting it to empty", () => {
    // Deliberate: an omitted constraint must be impossible to mistake for a
    // declared-empty one, so this fails loudly. #224 removed the allergies half; the
    // reasoning holds for what is left, and the column behind it is still `not null`
    // with no default (20260810000000).
    const result = HouseholdSchema.safeParse({ members: [{ type: "adult", portion_factor: 1 }] });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.at(-1))).toEqual(["dietary_flags"]);
  });
});

describe("member name", () => {
  const base = { type: "adult" as const, portion_factor: 1, dietary_flags: [] };

  it("is optional", () => {
    expect(HouseholdSchema.safeParse({ members: [base] }).success).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    const parsed = HouseholdSchema.parse({ members: [{ ...base, name: "  Ella  " }] });

    expect(parsed.members[0]!.name).toBe("Ella");
  });

  it("normalises a blank name to absent, so blank and unset cannot mean different things", () => {
    const parsed = HouseholdSchema.parse({ members: [{ ...base, name: "   " }] });

    expect(parsed.members[0]!.name).toBeUndefined();
  });

  it("rejects a name longer than the bound", () => {
    const result = HouseholdSchema.safeParse({
      members: [{ ...base, name: "x".repeat(MEMBER_NAME_MAX_LENGTH + 1) }],
    });

    expect(result.success).toBe(false);
  });
});

describe("memberLabels", () => {
  const adult = { type: "adult" as const, portion_factor: 1, dietary_flags: [] };
  const child = { type: "child" as const, portion_factor: 0.5, dietary_flags: [] };

  it("numbers unnamed members within their own type", () => {
    expect(memberLabels([adult, adult, child, child])).toEqual([
      "Vuxen 1",
      "Vuxen 2",
      "Barn 1",
      "Barn 2",
    ]);
  });

  it("prefers a member's own name where they have one", () => {
    expect(memberLabels([{ ...adult, name: "Ella" }, adult, child])).toEqual([
      "Ella",
      "Vuxen 2",
      "Barn 1",
    ]);
  });

  it("keeps the ordinal counting named members, so the numbering matches the roster position", () => {
    // "Vuxen 2" would be wrong for the third adult — it would suggest there are two.
    expect(memberLabels([adult, { ...adult, name: "Ella" }, adult])).toEqual([
      "Vuxen 1",
      "Ella",
      "Vuxen 3",
    ]);
  });
});
