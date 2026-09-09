import { describe, expect, it } from "vitest";
import { parseDinersFromQuery, parsePortionsFromQuery } from "./diners.js";
import { MAX_PORTIONS, MIN_PORTIONS } from "../engine/quantities.js";
import { mealDiners } from "../engine/constraints.js";
import type { HouseholdMember } from "../schema/household.js";

function member(overrides: Partial<HouseholdMember> = {}): HouseholdMember {
  return { type: "adult", portion_factor: 1, dietary_flags: [], ...overrides };
}

describe("parseDinersFromQuery", () => {
  it("parses a comma-separated index list", () => {
    expect(parseDinersFromQuery("0,2")).toEqual(new Set([0, 2]));
  });

  it("tolerates whitespace and repeated indices", () => {
    expect(parseDinersFromQuery(" 1 , 0 , 1 ")).toEqual(new Set([0, 1]));
  });

  it("accepts a single index", () => {
    expect(parseDinersFromQuery("3")).toEqual(new Set([3]));
  });

  // Every case below resolves to "the whole household" rather than to a 400. This is
  // the one query parameter with no error path — see the module comment.
  const widensToEveryone: { name: string; raw: unknown }[] = [
    { name: "absent", raw: undefined },
    { name: "empty string", raw: "" },
    { name: "only separators", raw: ",,," },
    { name: "only whitespace", raw: "   " },
    { name: "an array (?diners=0&diners=1)", raw: ["0", "1"] },
    { name: "a bracketed object (?diners[a]=1)", raw: { a: "1" } },
    { name: "a non-numeric token", raw: "alla" },
    { name: "a numeric prefix on garbage", raw: "1abc" },
    // Number("0x1") is 1 and Number("1e2") is 100 — both would have silently named a
    // real member under a bare Number() check.
    { name: "a hex literal", raw: "0x1" },
    { name: "exponent notation", raw: "1e2" },
    { name: "a plus sign", raw: "+1" },
    { name: "an index beyond exact integers", raw: "99999999999999999999" },
    { name: "a fractional index", raw: "0.5" },
    { name: "a negative index", raw: "-1" },
    { name: "one good index and one bad one", raw: "0,alla" },
    { name: "SQL-ish junk", raw: "0; drop table households" },
  ];

  it.each(widensToEveryone)("$name yields undefined, i.e. the whole household", ({ raw }) => {
    expect(parseDinersFromQuery(raw)).toBeUndefined();
  });

  it("never throws, for any input", () => {
    const hostile: unknown[] = [null, 0, 1, true, [], {}, () => 0, Symbol("x"), 12n, NaN];

    for (const raw of hostile) {
      expect(() => parseDinersFromQuery(raw)).not.toThrow();
      expect(parseDinersFromQuery(raw)).toBeUndefined();
    }
  });

  it("hands an out-of-range index straight through to the engine, which widens it", () => {
    // The division of labour: this module does not know the roster, so range is the
    // engine's call. Asserted end to end so neither half can quietly stop covering it.
    const roster = [member({ dietary_flags: ["vegan"] }), member()];

    expect(parseDinersFromQuery("5")).toEqual(new Set([5]));
    expect(mealDiners(roster, parseDinersFromQuery("5")).constraints.dietary_flags).toEqual([
      "vegan",
    ]);
  });

  it("round-trips a real selection through the engine", () => {
    const roster = [member({ dietary_flags: ["vegan"] }), member({ dietary_flags: ["vegetarian"] })];

    expect(mealDiners(roster, parseDinersFromQuery("1")).constraints.dietary_flags).toEqual([
      "vegetarian",
    ]);
  });
});

// #231: the portion count a meal is scaled to, when the household stepped it.
describe("parsePortionsFromQuery", () => {
  it("takes a usable count, clamped into range", () => {
    expect(parsePortionsFromQuery("4")).toBe(4);
    expect(parsePortionsFromQuery(" 6 ")).toBe(6);
    expect(parsePortionsFromQuery("2.5")).toBe(2.5);
    expect(parsePortionsFromQuery("9999")).toBe(MAX_PORTIONS);
    expect(parsePortionsFromQuery("0.25")).toBe(MIN_PORTIONS);
  });

  it("falls back to undefined — the diner-derived total — for anything unusable", () => {
    // No error path, same idiom as parseDinersFromQuery above: a 400 would replace a
    // wrong number with a dead end, and the route echoes what it scaled to anyway, so
    // the count on screen can never disagree with the amounts under it.
    for (const raw of ["", "   ", "abc", "-3", "0", "NaN", "Infinity", undefined, 4, ["4"], null]) {
      expect(parsePortionsFromQuery(raw)).toBeUndefined();
    }
  });
});
