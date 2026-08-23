import { describe, expect, it, vi } from "vitest";
import type { Cuisine } from "../../src/schema/recipeTemplate";
import type { TonightResponse } from "./api";
import {
  INITIAL_REFINEMENT,
  isAxisActive,
  MAX_CUISINE_PROBES,
  refinementReducer,
  searchOtherCuisine,
  WEIGHT_ON,
  type RefinementState,
} from "./refinement";

// One test per chip transition, plus the two paths through the cuisine search.
// Deliberately no React here — the chips' *behaviour* is this reducer plus
// searchOtherCuisine, and testing it directly is what makes App.test.tsx able to
// stay a thin rendering smoke test (CLAUDE.md's testing weighting).

function suggestion(id: string, cuisine: Cuisine = "swedish_nordic"): TonightResponse {
  return {
    result: {
      template: { id, name: id, blurb: "Testblurb.", cost_tier: "mid", prep_time_band: "20-40min", effort_level: "moderate", cuisine },
      ingredients: [],
      substitutions: [],
      score: 1,
      reasonCodes: [],
      cookedToday: false,
    },
    portions: 2,
    diners: [{ label: "Vuxen 1" }, { label: "Vuxen 2" }],
  };
}

const exhausted: TonightResponse = {
  result: null,
  reason: "no_more_suggestions",
  portions: 2,
  diners: [{ label: "Vuxen 1" }, { label: "Vuxen 2" }],
};

function stateWith(patch: Partial<RefinementState> = {}): RefinementState {
  return { ...INITIAL_REFINEMENT, ...patch };
}

describe("refinementReducer — Billigare / Snabbare", () => {
  it("turns price on at full strength on the first tap, and counts the reroll", () => {
    const next = refinementReducer(INITIAL_REFINEMENT, { type: "toggle_axis", axis: "price" });

    expect(next.weights).toEqual({ price: WEIGHT_ON, time: 0, variation: 0, simplicity: 0 });
    expect(next.rerollDepth).toBe(1);
  });

  it("toggles time independently of price", () => {
    const afterCost = refinementReducer(INITIAL_REFINEMENT, { type: "toggle_axis", axis: "price" });
    const afterTime = refinementReducer(afterCost, { type: "toggle_axis", axis: "time" });

    expect(afterTime.weights).toEqual({
      price: WEIGHT_ON,
      time: WEIGHT_ON,
      variation: 0,
      simplicity: 0,
    });
    expect(afterTime.rerollDepth).toBe(2);
  });

  it("a second tap turns the axis back off — no level in between", () => {
    let state = INITIAL_REFINEMENT;

    state = refinementReducer(state, { type: "toggle_axis", axis: "price" });
    expect(isAxisActive(state, "price")).toBe(true);
    expect(state.weights.price).toBe(WEIGHT_ON);

    state = refinementReducer(state, { type: "toggle_axis", axis: "price" });
    expect(isAxisActive(state, "price")).toBe(false);
    expect(state.weights.price).toBe(0);
  });

  it("every tap changes the state and counts the reroll, including a tap that turns the axis off", () => {
    const on = stateWith({
      weights: { price: WEIGHT_ON, time: 0, variation: 0, simplicity: 0 },
      rerollDepth: 5,
    });

    const next = refinementReducer(on, { type: "toggle_axis", axis: "price" });

    expect(next).not.toBe(on);
    expect(next.weights.price).toBe(0);
    expect(next.rerollDepth).toBe(6);
  });
});

describe("refinementReducer — reroll, exclusion and reset", () => {
  it("counts a plain reroll without touching the weights", () => {
    const weighted = stateWith({
      weights: { price: 2, time: 1, variation: 0, simplicity: 0 },
      excludedTemplateIds: ["a"],
    });

    const next = refinementReducer(weighted, { type: "reroll", chip: "something_else" });

    expect(next.weights).toEqual({ price: 2, time: 1, variation: 0, simplicity: 0 });
    expect(next.excludedTemplateIds).toEqual(["a"]);
    expect(next.rerollDepth).toBe(1);
  });

  it("adds each shown suggestion to the exclusion set, without double-counting", () => {
    const shownOnce = refinementReducer(INITIAL_REFINEMENT, {
      type: "suggestion_shown",
      templateId: "kycklinggryta",
    });
    const shownAgain = refinementReducer(shownOnce, {
      type: "suggestion_shown",
      templateId: "kycklinggryta",
    });

    expect(shownOnce.excludedTemplateIds).toEqual(["kycklinggryta"]);
    expect(shownAgain).toBe(shownOnce);
    // Showing a dish is not a refinement — only chip taps move the depth.
    expect(shownOnce.rerollDepth).toBe(0);
  });

  it("merges cuisine exclusions into the existing set", () => {
    const state = stateWith({ excludedTemplateIds: ["a"] });

    const next = refinementReducer(state, { type: "exclude_templates", templateIds: ["a", "b"] });

    expect(next.excludedTemplateIds).toEqual(["a", "b"]);
  });

  it("resets weights and exclusions to defaults, keeping the session's reroll depth", () => {
    const deep = stateWith({
      weights: { price: 3, time: 2, variation: 1, simplicity: 4 },
      excludedTemplateIds: ["a", "b", "c"],
      rerollDepth: 6,
    });

    const next = refinementReducer(deep, { type: "reset" });

    expect(next.weights).toEqual({ price: 0, time: 0, variation: 0, simplicity: 0 });
    expect(next.excludedTemplateIds).toEqual([]);
    // Reset restores the suggestion, not the household's patience.
    expect(next.rerollDepth).toBe(7);
  });
});

describe("searchOtherCuisine", () => {
  it("returns the first different-cuisine suggestion and excludes only the current dish", async () => {
    const request = vi.fn().mockResolvedValue(suggestion("pastagratang", "italian_mediterranean"));

    const outcome = await searchOtherCuisine(
      request,
      stateWith({ excludedTemplateIds: ["kottbullar"] }),
      "kottbullar",
      "swedish_nordic",
    );

    expect(outcome.response.result?.template.id).toBe("pastagratang");
    expect(outcome.excludedTemplateIds).toEqual(["kottbullar"]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(["kottbullar"], "kottbullar");
  });

  it("keeps excluding same-cuisine dishes until a different cuisine comes back", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(suggestion("raggmunk", "swedish_nordic"))
      .mockResolvedValueOnce(suggestion("tacos", "mexican_texmex"));

    const outcome = await searchOtherCuisine(
      request,
      stateWith({ excludedTemplateIds: ["kottbullar"] }),
      "kottbullar",
      "swedish_nordic",
    );

    expect(outcome.response.result?.template.id).toBe("tacos");
    // Every same-cuisine dish the search rejected is a dish the household asked
    // not to see, so it stays excluded for the session.
    expect(outcome.excludedTemplateIds).toEqual(["kottbullar", "raggmunk"]);
    expect(request).toHaveBeenNthCalledWith(2, ["kottbullar", "raggmunk"], "kottbullar");
  });

  it("falls back to a plain reroll when every remaining candidate shares the cuisine", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(suggestion("raggmunk", "swedish_nordic"))
      .mockResolvedValue(exhausted);

    const outcome = await searchOtherCuisine(
      request,
      stateWith({ excludedTemplateIds: ["kottbullar"] }),
      "kottbullar",
      "swedish_nordic",
    );

    // The first same-cuisine dish is shown rather than dead-ending the household,
    // and only the dish it actually rejected is excluded.
    expect(outcome.response.result?.template.id).toBe("raggmunk");
    expect(outcome.excludedTemplateIds).toEqual(["kottbullar"]);
  });

  it("gives up after MAX_CUISINE_PROBES and shows the first same-cuisine dish", async () => {
    const request = vi
      .fn()
      .mockImplementation((exclude: readonly string[]) =>
        Promise.resolve(suggestion(`husman-${exclude.length}`, "swedish_nordic")),
      );

    const outcome = await searchOtherCuisine(
      request,
      stateWith(),
      "kottbullar",
      "swedish_nordic",
    );

    expect(request).toHaveBeenCalledTimes(MAX_CUISINE_PROBES);
    expect(outcome.response.result?.template.id).toBe("husman-1");
    expect(outcome.excludedTemplateIds).toEqual(["kottbullar"]);
  });

  it("surfaces the empty state when nothing at all remains", async () => {
    const request = vi.fn().mockResolvedValue(exhausted);

    const outcome = await searchOtherCuisine(
      request,
      stateWith({ excludedTemplateIds: ["kottbullar"] }),
      "kottbullar",
      "swedish_nordic",
    );

    expect(outcome.response.result).toBeNull();
    expect(outcome.response).toBe(exhausted);
  });
});
