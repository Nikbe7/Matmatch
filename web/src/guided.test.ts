import { describe, expect, it } from "vitest";
import {
  GUIDED_INTENTS,
  INITIAL_GUIDED,
  MIN_PORTIONS,
  guidedReducer,
  isFirstStep,
  mainParameter,
  matchesIngredientQuery,
  previousStep,
  type GuidedAction,
  type GuidedState,
} from "./guided";

// The guided flow's step machine (UX_FLOW §5). Deliberately no React here — the
// flow's *behaviour* is this reducer, and testing it directly is what lets
// GuidedFlow.test.tsx stay a rendering test (CLAUDE.md's testing weighting).

/** Replays a sequence of taps from the initial state, as a session actually would. */
function run(...actions: GuidedAction[]): GuidedState {
  return actions.reduce(guidedReducer, INITIAL_GUIDED);
}

const pickChicken: GuidedAction[] = [
  { type: "select_intent", intent: "dinner_idea" },
  { type: "select_main", ingredientId: "kycklingfile" },
];

describe("the intent step", () => {
  it("offers the five chips that have a real engine lever behind them", () => {
    // "Matlådor" is absent on purpose: it needs a household lunch-box count and a
    // keeps/reheats signal that do not exist, and a chip that quietly behaves like
    // "Middagsidé" is worse than no chip. If it is ever added here, it must be
    // because the data landed — see the DECISION_LOG entry for this flow.
    expect(GUIDED_INTENTS.map((intent) => intent.id)).toEqual([
      "dinner_idea",
      "cheap",
      "use_what_i_have",
      "high_protein",
      "surprise_me",
    ]);
  });

  it("moves to the main-ingredient step", () => {
    const state = run({ type: "select_intent", intent: "cheap" });

    expect(state.step).toBe("main");
    expect(state.intent).toBe("cheap");
  });

  it("sends 'Överraska mig' straight to the cards, with the engine picking", () => {
    const state = run({ type: "select_intent", intent: "surprise_me" });

    expect(state.step).toBe("directions");
    expect(state.main).toEqual({ kind: "auto" });
    expect(state.pantry).toEqual([]);
  });
});

describe("the main-ingredient step", () => {
  it("records a tapped ingredient and moves on to the pantry", () => {
    const state = run(...pickChicken);

    expect(state.main).toEqual({ kind: "ingredient", ingredientId: "kycklingfile" });
    expect(state.step).toBe("pantry");
  });

  it("records 'Föreslå åt mig' as the engine's call, not an ingredient", () => {
    const state = run({ type: "select_intent", intent: "dinner_idea" }, { type: "suggest_main" });

    expect(state.main).toEqual({ kind: "auto" });
    expect(state.step).toBe("pantry");
  });
});

describe("the main-ingredient step's type-to-filter (#110)", () => {
  it("holds the query in the reducer, not component state", () => {
    const state = run(
      { type: "select_intent", intent: "dinner_idea" },
      { type: "set_main_query", query: "lax" },
    );

    expect(state.mainQuery).toBe("lax");
    expect(state.step).toBe("main");
  });

  it("never changes which ingredient is selected — it is a display filter only", () => {
    const filtered = run(
      { type: "select_intent", intent: "dinner_idea" },
      { type: "set_main_query", query: "kyckling" },
    );
    expect(filtered.main).toBeNull();

    // Selecting still requires the explicit tap; typing a query that happens to
    // match an ingredient's name does not select it.
    const selected = guidedReducer(filtered, {
      type: "select_main",
      ingredientId: "kycklingfile",
    });
    expect(selected.main).toEqual({ kind: "ingredient", ingredientId: "kycklingfile" });
  });

  it("clears the query once a choice is made, so the next visit starts on the full grid", () => {
    const selected = run(
      { type: "select_intent", intent: "dinner_idea" },
      { type: "set_main_query", query: "lax" },
      { type: "select_main", ingredientId: "laxfile" },
    );

    expect(selected.mainQuery).toBe("");
  });

  it("clears the query when 'Föreslå åt mig' is used instead of a tap", () => {
    const state = run(
      { type: "select_intent", intent: "dinner_idea" },
      { type: "set_main_query", query: "lax" },
      { type: "suggest_main" },
    );

    expect(state.mainQuery).toBe("");
  });

  it("starts every session with an empty query", () => {
    expect(INITIAL_GUIDED.mainQuery).toBe("");
  });
});

describe("matchesIngredientQuery — the deterministic string match behind the filter", () => {
  it("matches a case-insensitive substring anywhere in the name", () => {
    expect(matchesIngredientQuery("Kycklingfilé", "kyckling")).toBe(true);
    expect(matchesIngredientQuery("Kycklingfilé", "FILÉ")).toBe(true);
    expect(matchesIngredientQuery("Kycklingfilé", "filé")).toBe(true);
  });

  it("matches regardless of diacritics on either side", () => {
    expect(matchesIngredientQuery("Filé", "file")).toBe(true);
    expect(matchesIngredientQuery("Grönsaksbuljong", "gronsak")).toBe(true);
    expect(matchesIngredientQuery("Räkor", "rakor")).toBe(true);
  });

  it("does not match a substring that is not there", () => {
    expect(matchesIngredientQuery("Kycklingfilé", "nötkött")).toBe(false);
  });

  it("matches everything for an empty query", () => {
    expect(matchesIngredientQuery("Lax", "")).toBe(true);
  });
});

describe("the pantry step", () => {
  it("toggles ingredients on and off", () => {
    const state = run(
      ...pickChicken,
      { type: "toggle_pantry", ingredientId: "ris" },
      { type: "toggle_pantry", ingredientId: "gul-lok" },
    );

    expect(state.pantry).toEqual(["ris", "gul-lok"]);
    expect(guidedReducer(state, { type: "toggle_pantry", ingredientId: "ris" }).pantry).toEqual([
      "gul-lok",
    ]);
  });

  it("allows continuing with nothing selected — step 3 is optional", () => {
    const state = run(...pickChicken, { type: "confirm_pantry" });

    expect(state.step).toBe("directions");
    expect(state.pantry).toEqual([]);
  });
});

describe("choosing a direction and confirming portions", () => {
  const toPortions: GuidedAction[] = [
    ...pickChicken,
    { type: "confirm_pantry" },
    { type: "choose_direction", templateId: "kycklinggryta", portions: 2.5 },
  ];

  it("seeds the stepper from the household's own portion total", () => {
    const state = run(...toPortions);

    expect(state.step).toBe("portions");
    expect(state.chosenTemplateId).toBe("kycklinggryta");
    expect(state.portions).toBe(2.5);
  });

  it("steps portions up and down", () => {
    const state = run(...toPortions, { type: "adjust_portions", delta: 1 });

    expect(state.portions).toBe(3.5);
    expect(guidedReducer(state, { type: "adjust_portions", delta: -1 }).portions).toBe(2.5);
  });

  it("never steps below one portion — a list for nobody is not a state", () => {
    const state = run(
      ...pickChicken,
      { type: "confirm_pantry" },
      { type: "choose_direction", templateId: "x", portions: 1 },
      { type: "adjust_portions", delta: -1 },
      { type: "adjust_portions", delta: -1 },
    );

    expect(state.portions).toBe(MIN_PORTIONS);
  });

  it("reaches the shopping list", () => {
    expect(run(...toPortions, { type: "confirm_portions" }).step).toBe("shopping");
  });

  it("refuses to reach the shopping list without a chosen dish", () => {
    expect(run(...pickChicken, { type: "confirm_pantry" }, { type: "confirm_portions" }).step).toBe(
      "directions",
    );
  });
});

describe("dish_no_longer_safe — a diner change made the chosen dish unsafe (#133)", () => {
  const toPortions: GuidedAction[] = [
    ...pickChicken,
    { type: "confirm_pantry" },
    { type: "choose_direction", templateId: "kycklinggryta", portions: 2.5 },
  ];

  it("releases the choice and returns to the cards, from the portions step", () => {
    const state = run(...toPortions, { type: "dish_no_longer_safe" });

    expect(state.step).toBe("directions");
    expect(state.chosenTemplateId).toBeNull();
    expect(state.portions).toBeNull();
  });

  it("releases the choice and returns to the cards, from the shopping step", () => {
    const state = run(...toPortions, { type: "confirm_portions" }, { type: "dish_no_longer_safe" });

    expect(state.step).toBe("directions");
    expect(state.chosenTemplateId).toBeNull();
    expect(state.portions).toBeNull();
  });

  it("preserves the intent, main ingredient and pantry — a diner change is a refinement, not a reset", () => {
    const state = run(...toPortions, { type: "dish_no_longer_safe" });

    expect(state.intent).toBe("dinner_idea");
    expect(state.main).toEqual({ kind: "ingredient", ingredientId: "kycklingfile" });
  });
});

describe("diner_change_portions — the kept dish's number stays true to what it was scaled for (#133)", () => {
  const toPortions: GuidedAction[] = [
    ...pickChicken,
    { type: "confirm_pantry" },
    { type: "choose_direction", templateId: "kycklinggryta", portions: 2.5 },
  ];

  it("reseeds from the fresh diner-derived total, discarding a manual stepper adjustment", () => {
    const state = run(
      ...toPortions,
      { type: "adjust_portions", delta: 1 },
      { type: "diner_change_portions", portions: 1.5 },
    );

    expect(state.portions).toBe(1.5);
  });

  it("still floors at MIN_PORTIONS, same as the stepper itself", () => {
    const state = run(...toPortions, { type: "diner_change_portions", portions: 0.5 });

    expect(state.portions).toBe(MIN_PORTIONS);
  });

  it("is a no-op once the choice has already been released", () => {
    const released = run(...toPortions, { type: "dish_no_longer_safe" });

    const state = guidedReducer(released, { type: "diner_change_portions", portions: 3 });

    expect(state).toBe(released);
  });
});

describe("back navigation preserves earlier selections (requirement 8)", () => {
  it("walks the whole flow backwards without losing the intent, ingredient or pantry", () => {
    const atShopping = run(
      { type: "select_intent", intent: "cheap" },
      { type: "select_main", ingredientId: "kycklingfile" },
      { type: "toggle_pantry", ingredientId: "ris" },
      { type: "toggle_pantry", ingredientId: "gul-lok" },
      { type: "confirm_pantry" },
      { type: "choose_direction", templateId: "kycklinggryta", portions: 2 },
      { type: "confirm_portions" },
    );

    const atPortions = guidedReducer(atShopping, { type: "back" });
    expect(atPortions.step).toBe("portions");

    const atDirections = guidedReducer(atPortions, { type: "back" });
    expect(atDirections.step).toBe("directions");
    // The dish choice is released — re-entering the step is a real choice again —
    // but nothing the household selected before it is.
    expect(atDirections.chosenTemplateId).toBeNull();

    const atPantry = guidedReducer(atDirections, { type: "back" });
    expect(atPantry.step).toBe("pantry");
    expect(atPantry.pantry).toEqual(["ris", "gul-lok"]);

    const atMain = guidedReducer(atPantry, { type: "back" });
    expect(atMain.step).toBe("main");
    expect(atMain.main).toEqual({ kind: "ingredient", ingredientId: "kycklingfile" });

    const atIntent = guidedReducer(atMain, { type: "back" });
    expect(atIntent.step).toBe("intent");
    expect(atIntent.intent).toBe("cheap");
  });

  it("returns to the chips from the cards under 'Överraska mig', which skipped two steps", () => {
    const state = run({ type: "select_intent", intent: "surprise_me" });

    expect(previousStep(state)).toBe("intent");
    expect(guidedReducer(state, { type: "back" }).step).toBe("intent");
  });

  it("reports the first step, where 'Tillbaka' leaves the flow instead", () => {
    expect(isFirstStep(INITIAL_GUIDED)).toBe(true);
    expect(isFirstStep(run(...pickChicken))).toBe(false);
  });

  it("keeps a re-picked dish's portions seeded from the household, not from a stepper value", () => {
    // Going back and choosing a different dish must not carry over a number the
    // household set for a dish it abandoned.
    const adjusted = run(
      ...pickChicken,
      { type: "confirm_pantry" },
      { type: "choose_direction", templateId: "a", portions: 2 },
      { type: "adjust_portions", delta: 4 },
      { type: "back" },
      { type: "choose_direction", templateId: "b", portions: 2 },
    );

    expect(adjusted.portions).toBe(2);
  });
});

describe("the §9 loosen actions", () => {
  const stuck = run(
    { type: "select_intent", intent: "use_what_i_have" },
    { type: "select_main", ingredientId: "kycklingfile" },
    { type: "toggle_pantry", ingredientId: "ris" },
    { type: "confirm_pantry" },
  );

  it("drops the pantry without leaving the cards — recovery is a refetch, not a retreat", () => {
    const loosened = guidedReducer(stuck, { type: "clear_pantry" });

    expect(loosened.pantry).toEqual([]);
    expect(loosened.step).toBe("directions");
    expect(loosened.main).toEqual({ kind: "ingredient", ingredientId: "kycklingfile" });
  });

  it("drops the main-ingredient constraint entirely, which 'auto' would not do", () => {
    const loosened = guidedReducer(stuck, { type: "clear_main" });

    expect(loosened.main).toEqual({ kind: "any" });
    expect(mainParameter(loosened)).toBe("any");
    expect(loosened.step).toBe("directions");
  });

  it("starts over from the chips on restart", () => {
    expect(guidedReducer(stuck, { type: "restart" })).toEqual(INITIAL_GUIDED);
  });
});

describe("mainParameter — what the request actually sends", () => {
  it("is null before the ingredient step is answered", () => {
    expect(mainParameter(INITIAL_GUIDED)).toBeNull();
  });

  it("sends the ingredient id, 'auto' or 'any', matching the route's three forms", () => {
    expect(mainParameter(run(...pickChicken))).toBe("kycklingfile");
    expect(mainParameter(run({ type: "select_intent", intent: "surprise_me" }))).toBe("auto");
    expect(
      mainParameter(guidedReducer(run(...pickChicken), { type: "clear_main" })),
    ).toBe("any");
  });
});

describe("pantry input is never persisted (CLAUDE.md non-negotiable)", () => {
  // Session-scoped and ephemeral by decision, not by omission. This module has no
  // load/save pair on purpose — do not add one to "fix" a lost selection after a
  // reload. A standing inventory goes stale, and MVP is not allowed to keep one.

  it("exposes no persistence API at all — nothing to call, nothing to accidentally wire up", async () => {
    const guided = await import("./guided");

    expect(Object.keys(guided).filter((name) => /save|load|store|persist/i.test(name))).toEqual([]);
  });

  it("starts every session with an empty pantry, whatever a previous one selected", () => {
    // No rehydration path exists: the initial state is a constant, so a reload can
    // only ever land on an empty pantry.
    expect(INITIAL_GUIDED.pantry).toEqual([]);
    expect(guidedReducer(INITIAL_GUIDED, { type: "restart" }).pantry).toEqual([]);
  });
});

describe("the portions step's floor, with diner scoping (#112)", () => {
  it("never seeds below MIN_PORTIONS, even for a diner set that totals less", () => {
    // Reachable since #112: one adult and one child, adult deselected, is 0.5. Seeding
    // there would open the step on a value its own "−" button is already disabled for.
    const state = run(...pickChicken, {
      type: "choose_direction",
      templateId: "kycklinggryta",
      portions: 0.5,
    });

    expect(state.portions).toBe(MIN_PORTIONS);
  });

  it("still seeds a fractional total above the floor verbatim", () => {
    const state = run(...pickChicken, {
      type: "choose_direction",
      templateId: "kycklinggryta",
      portions: 1.5,
    });

    expect(state.portions).toBe(1.5);
  });
});
