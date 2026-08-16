import { describe, expect, it } from "vitest";
import type { SuggestionReasonCode } from "./api";
import { formatPortions, formatQuantity, portionsNoun, suggestionReasonLine } from "./display";

// #122: display.ts owns the only phrasing of a SuggestionReasonCode, so this is
// where "never a number" and "never a list" get checked — the engine (ranking.ts)
// only ever hands back codes, so it cannot be the source of a stray figure.

const ALL_CODES: readonly SuggestionReasonCode[] = [
  "in_season",
  "not_recently_cooked",
  "cost_preference",
  "time_preference",
  "different_from_last_time",
];

describe("suggestionReasonLine", () => {
  it("is silent (null) for no reason codes, never an empty string", () => {
    expect(suggestionReasonLine([])).toBeNull();
  });

  it("renders a single reason as one sentence", () => {
    expect(suggestionReasonLine(["in_season"])).toBe("Valt för att den är i säsong.");
  });

  it("joins exactly two reasons with 'och', never a list", () => {
    const line = suggestionReasonLine(["in_season", "not_recently_cooked"]);
    expect(line).toContain(" och ");
    expect(line?.split(" och ")).toHaveLength(2);
  });

  it("never contains a digit, for any code or pair of codes", () => {
    for (const code of ALL_CODES) {
      expect(suggestionReasonLine([code])).not.toMatch(/\d/);
    }
    for (const first of ALL_CODES) {
      for (const second of ALL_CODES) {
        if (first === second) continue;
        expect(suggestionReasonLine([first, second])).not.toMatch(/\d/);
      }
    }
  });
});

// #123. The numbers arrive already scaled and rounded from the engine, so these are
// about wording only — the Swedish decimal comma and the two units that inflect.
describe("formatQuantity", () => {
  it("writes a whole amount with its unit", () => {
    expect(formatQuantity({ kind: "amount", amount: 600, unit: "g" })).toBe("600 g");
    expect(formatQuantity({ kind: "amount", amount: 2, unit: "dl" })).toBe("2 dl");
  });

  it("uses a decimal comma, never a point", () => {
    expect(formatQuantity({ kind: "amount", amount: 1.5, unit: "dl" })).toBe("1,5 dl");
    expect(formatQuantity({ kind: "amount", amount: 0.5, unit: "msk" })).toBe("0,5 msk");
  });

  it("inflects only the two units that have a plural in Swedish", () => {
    expect(formatQuantity({ kind: "amount", amount: 1, unit: "klyfta" })).toBe("1 klyfta");
    expect(formatQuantity({ kind: "amount", amount: 3, unit: "klyfta" })).toBe("3 klyftor");
    expect(formatQuantity({ kind: "amount", amount: 1, unit: "kruka" })).toBe("1 kruka");
    expect(formatQuantity({ kind: "amount", amount: 2, unit: "kruka" })).toBe("2 krukor");
    // Invariant units stay as they are at any amount.
    expect(formatQuantity({ kind: "amount", amount: 4, unit: "st" })).toBe("4 st");
    expect(formatQuantity({ kind: "amount", amount: 3, unit: "krm" })).toBe("3 krm");
    expect(formatQuantity({ kind: "amount", amount: 2, unit: "tsk" })).toBe("2 tsk");
  });

  it("words the no-quantity marker rather than showing a number", () => {
    expect(formatQuantity({ kind: "to_taste" })).toBe("efter smak");
  });
});

// #176: singular only at exactly 1 portion — every other count, including the
// 1.5 a mixed adult/child household can land on, takes the plural.
describe("portionsNoun", () => {
  it("is singular only at exactly 1", () => {
    expect(portionsNoun(1)).toBe("portion");
  });

  it("is plural for a fractional count, even one that rounds toward 1", () => {
    expect(portionsNoun(1.5)).toBe("portioner");
  });

  it("is plural for any count above 1", () => {
    expect(portionsNoun(2)).toBe("portioner");
    expect(portionsNoun(4)).toBe("portioner");
  });
});

describe("formatPortions", () => {
  it("renders singular for 1 portion", () => {
    expect(formatPortions(1)).toBe("För 1 portion");
  });

  it("renders plural for a fractional count", () => {
    // formatPortionsCount is unchanged by #176 — it still renders the raw
    // decimal point, not a Swedish comma; only the noun is new here.
    expect(formatPortions(1.5)).toBe("För 1.5 portioner");
  });

  it("renders plural for 2 and 4 portions", () => {
    expect(formatPortions(2)).toBe("För 2 portioner");
    expect(formatPortions(4)).toBe("För 4 portioner");
  });
});
