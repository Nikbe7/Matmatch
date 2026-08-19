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

  it("shows only the strongest reason when the engine sends more than one (#185)", () => {
    // The engine still derives up to two (`MAX_SUGGESTION_REASONS`, unchanged) — the
    // card is a heading over the choice, not an account of the ranking, so it takes
    // the first and stops. Two clauses joined with "och" wrapped onto a second line,
    // which is what set our line apart from the reference's.
    const line = suggestionReasonLine(["in_season", "not_recently_cooked"]);
    expect(line).toBe("Valt för att den är i säsong.");
    expect(line).not.toContain(" och ");
  });

  it("keeps the engine's order — the first code is the one shown", () => {
    expect(suggestionReasonLine(["not_recently_cooked", "in_season"])).toBe(
      "Valt för att ni inte lagat den på ett tag.",
    );
  });

  it("never renders more than one clause, for any pair of codes", () => {
    for (const first of ALL_CODES) {
      for (const second of ALL_CODES) {
        if (first === second) continue;
        // Every phrase in the map is a single clause with no "och" of its own, so
        // the connector's absence is a faithful proxy for "one reason".
        expect(suggestionReasonLine([first, second])).not.toContain(" och ");
      }
    }
  });

  describe("pantry_match wins whenever it fired (#185)", () => {
    it("takes the line even when the engine ranked another reason first", () => {
      expect(suggestionReasonLine(["in_season", "pantry_match"], ["potatis"])).toBe(
        "Valt för att ni har potatis hemma.",
      );
    });

    it("names up to two ingredients in one clause, which is the one place 'och' belongs", () => {
      expect(suggestionReasonLine(["pantry_match"], ["potatis", "gul lök"])).toBe(
        "Valt för att ni har potatis och gul lök hemma.",
      );
    });

    it("falls through to the next reason when no names came with it", () => {
      // A pantry reason that cannot name what it matched would be the app claiming
      // credit for something the household cannot check.
      expect(suggestionReasonLine(["pantry_match", "in_season"], [])).toBe(
        "Valt för att den är i säsong.",
      );
    });

    it("is silent when it fired alone with no names", () => {
      expect(suggestionReasonLine(["pantry_match"], [])).toBeNull();
    });
  });

  it("addresses the household as 'ni', never 'du', in every phrase", () => {
    // Matmatch decides a dinner for a household, not for a person — the profile asks
    // "Vad är viktigt för er?" and portions are computed for everyone at the table.
    // Asserted over every code rather than spot-checked, so a phrase added later
    // cannot quietly reintroduce the singular on the one line that explains the choice.
    for (const code of ALL_CODES) {
      const line = suggestionReasonLine([code])!;
      expect(line).not.toMatch(/\b(du|dig|din|ditt|dina)\b/i);
    }
    expect(suggestionReasonLine(["pantry_match"], ["potatis"])).not.toMatch(
      /\b(du|dig|din|ditt|dina)\b/i,
    );
  });

  it("is grammatical Swedish in every phrase (#185)", () => {
    // "annorlunda än ikväll ni lagade senast" shipped in #122 and read as broken
    // Swedish on the one line the card now leads with.
    expect(suggestionReasonLine(["different_from_last_time"])).toBe(
      "Valt för att den är annorlunda än det ni lagade senast.",
    );
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
