import { describe, expect, it } from "vitest";
import type { SuggestionReasonCode } from "./api";
import { suggestionReasonLine } from "./display";

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
