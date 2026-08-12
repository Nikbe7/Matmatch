// Session state for the guided quick-select flow (UX_FLOW §5). One reducer rather
// than six useStates, following refinement.ts: the steps share one object because a
// tap on any of them can move the step *and* a selection at once, and they must
// never drift apart.
//
// Nothing here is persisted — not the pantry, not the intent, not the step. That is
// a decision rather than an omission for the pantry specifically (CLAUDE.md's
// session-scoped non-negotiable, ARCHITECTURE §5's SessionPantryInput note): this
// module deliberately has no load/save pair the way shoppingListStorage.ts does, and
// adding one would reverse a decision rather than fill a gap. `guided.test.ts` asserts
// it by watching localStorage.

/** Chip ids as the API knows them — stable, never the Swedish label. */
export type GuidedIntent =
  | "dinner_idea"
  | "cheap"
  | "use_what_i_have"
  | "high_protein"
  | "surprise_me";

/**
 * The five chips UX_FLOW §5 step 1 lists, minus "Matlådor" — it needs a household
 * lunch-box count and a keeps/reheats signal that do not exist, and a chip that
 * quietly behaves like "Middagsidé" is worse than no chip. See the DECISION_LOG
 * entry for this flow.
 */
export const GUIDED_INTENTS: readonly { id: GuidedIntent; label: string }[] = [
  { id: "dinner_idea", label: "Middagsidé" },
  { id: "cheap", label: "Billigt" },
  { id: "use_what_i_have", label: "Använd det jag har" },
  { id: "high_protein", label: "Proteinrikt" },
  { id: "surprise_me", label: "Överraska mig" },
];

export type GuidedStep = "intent" | "main" | "pantry" | "directions" | "portions" | "shopping";

/** How step 2 was answered. Mirrors the route's `main` parameter one-to-one. */
export type MainSelection =
  | { kind: "ingredient"; ingredientId: string }
  | { kind: "auto" }
  | { kind: "any" };

export interface GuidedState {
  step: GuidedStep;
  intent: GuidedIntent | null;
  main: MainSelection | null;
  /**
   * Step 2's type-to-filter text, live in the reducer rather than component state
   * so it follows the same one-object-per-session rule as everything else here. It
   * only ever narrows the *display* of `options.mainIngredients` — it never reads
   * or writes `main`, so a query can never change which ingredient is selected.
   */
  mainQuery: string;
  /** Session-scoped, ephemeral, never written anywhere. */
  pantry: readonly string[];
  chosenTemplateId: string | null;
  /** Seeded from the household's own portion total, then adjusted by the steppers. */
  portions: number | null;
}

export const INITIAL_GUIDED: GuidedState = {
  step: "intent",
  intent: null,
  main: null,
  mainQuery: "",
  pantry: [],
  chosenTemplateId: null,
  portions: null,
};

export type GuidedAction =
  | { type: "select_intent"; intent: GuidedIntent }
  | { type: "select_main"; ingredientId: string }
  /** "Föreslå åt mig" — the engine picks from season, cost tier and history. */
  | { type: "suggest_main" }
  /** Step 2's type-to-filter input, as typed. */
  | { type: "set_main_query"; query: string }
  | { type: "toggle_pantry"; ingredientId: string }
  | { type: "confirm_pantry" }
  | { type: "choose_direction"; templateId: string; portions: number }
  | { type: "adjust_portions"; delta: number }
  | { type: "confirm_portions" }
  | { type: "back" }
  /** §9 loosen actions: widen the constraints without leaving the direction step. */
  | { type: "clear_pantry" }
  | { type: "clear_main" }
  | { type: "restart" }
  /**
   * #133: a diner change (from the "portions" or "shopping" step) made the chosen
   * dish unsafe. Back to "directions" — the fresh card set the same request just
   * fetched is already in hand — with the choice released, exactly like stepping
   * back manually. Never silent: the caller renders the server's `replacedFor`
   * alongside the new cards.
   */
  | { type: "dish_no_longer_safe" }
  /**
   * #133: the chosen dish survived a diner change — re-seeded from the
   * household's fresh diner-derived total, exactly like `choose_direction`
   * already does every time a direction is chosen. Any manual stepper
   * adjustment does not survive a diner change, deliberately: the number this
   * type carries is what the ingredients underneath it were actually scaled
   * for server-side, and letting the display drift from that would be its own
   * "silent swap" — the count would say one thing while the list said another.
   */
  | { type: "diner_change_portions"; portions: number };

/**
 * The smallest number of portions a shopping list can be for. One, not zero: a list
 * for nobody is not a state the flow has, and a stepper that can reach it just adds
 * a way to get stuck.
 */
export const MIN_PORTIONS = 1;

/**
 * Where "Tillbaka" goes from each step, preserving every earlier selection —
 * stepping back must never cost the household work it already did (requirement 8).
 *
 * "Överraska mig" is the one branch: it skips steps 2 and 3 outright, so going back
 * from the cards returns to the chips rather than to a pantry grid the household
 * never saw.
 */
export function previousStep(state: GuidedState): GuidedStep {
  switch (state.step) {
    case "shopping":
      // A resumed list (a reload in the shop) has no intent behind it and no
      // direction set to go back to, so "Tillbaka" starts the flow rather than
      // landing on a portions step with nothing to confirm.
      return state.intent === null ? "intent" : "portions";
    case "portions":
      return "directions";
    case "directions":
      return state.intent === "surprise_me" ? "intent" : "pantry";
    case "pantry":
      return "main";
    case "main":
    case "intent":
      return "intent";
    default: {
      const exhaustive: never = state.step;
      return exhaustive;
    }
  }
}

/** Whether "Tillbaka" leaves the flow entirely rather than moving within it. */
export function isFirstStep(state: GuidedState): boolean {
  return state.step === "intent";
}

/** The `main` query parameter for the current selection, or null before step 2. */
export function mainParameter(state: GuidedState): string | null {
  if (!state.main) return null;
  return state.main.kind === "ingredient" ? state.main.ingredientId : state.main.kind;
}

/**
 * Case- and diacritics-insensitive: NFD-decomposes so "Lax" matches "lax" and
 * "gron" matches "grön", then strips the combining marks NFD splits diacritics
 * into. Deterministic string comparison only — no fuzzy-match library, per the
 * type-to-filter issue's explicit scope.
 */
function normalizeForMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Whether an ingredient's Swedish name matches step 2's filter query. Exported so
 * both the safe grid and the allergy-excluded explanation list (a display-only
 * concern, never the selectable set) filter with the exact same rule.
 */
export function matchesIngredientQuery(name: string, query: string): boolean {
  return normalizeForMatch(name).includes(normalizeForMatch(query));
}

function toggle(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function guidedReducer(state: GuidedState, action: GuidedAction): GuidedState {
  switch (action.type) {
    case "select_intent":
      return {
        ...state,
        intent: action.intent,
        // "Överraska mig" is the whole point of the chip: no further questions, the
        // engine picks the main ingredient and the pantry step is skipped.
        ...(action.intent === "surprise_me"
          ? { step: "directions" as const, main: { kind: "auto" as const }, pantry: [] }
          : { step: "main" as const }),
      };

    case "select_main":
      return {
        ...state,
        main: { kind: "ingredient", ingredientId: action.ingredientId },
        // Leaving the step behind a choice, so the next visit starts on the full
        // grid again rather than on a query aimed at a dish already decided.
        mainQuery: "",
        step: "pantry",
      };

    case "suggest_main":
      return { ...state, main: { kind: "auto" }, mainQuery: "", step: "pantry" };

    case "set_main_query":
      return { ...state, mainQuery: action.query };

    case "toggle_pantry":
      return { ...state, pantry: toggle(state.pantry, action.ingredientId) };

    case "confirm_pantry":
      return { ...state, step: "directions" };

    case "choose_direction":
      return {
        ...state,
        chosenTemplateId: action.templateId,
        // Seeded from the household every time a direction is chosen, so a household
        // that goes back and picks a different dish starts from its own number again
        // rather than from a stepper value it set for a dish it abandoned.
        //
        // Clamped to the same floor `adjust_portions` enforces: with diner scoping
        // (#112) a sub-1 total is now reachable — one adult and one child, adult
        // deselected, is 0.5 — and seeding below the floor opens the step on a value
        // its own "−" button is already disabled for.
        portions: Math.max(MIN_PORTIONS, action.portions),
        step: "portions",
      };

    case "adjust_portions": {
      if (state.portions === null) return state;
      return { ...state, portions: Math.max(MIN_PORTIONS, state.portions + action.delta) };
    }

    case "confirm_portions":
      // Guarded rather than trusting the caller: reaching the shopping list without a
      // chosen dish would render a list for nothing.
      if (state.chosenTemplateId === null) return state;
      return { ...state, step: "shopping" };

    case "back": {
      const step = previousStep(state);
      // Selections survive deliberately (requirement 8) — only the choice belonging
      // to the step being left is released, so re-entering it is a real choice again.
      if (state.step === "portions") return { ...state, step, chosenTemplateId: null, portions: null };
      return { ...state, step };
    }

    case "clear_pantry":
      // Stays on "directions": loosening is a refetch, not a step backwards. Landing
      // the household back on the pantry grid would make the §9 recovery feel like
      // being sent to redo the thing that just failed.
      return { ...state, pantry: [] };

    case "clear_main":
      return { ...state, main: { kind: "any" } };

    case "restart":
      return INITIAL_GUIDED;

    case "dish_no_longer_safe":
      return { ...state, step: "directions", chosenTemplateId: null, portions: null };

    case "diner_change_portions":
      // Guarded like `adjust_portions`: nothing to reseed once the choice has
      // already been released (e.g. a slow response landing after the household
      // stepped back on its own).
      if (state.portions === null) return state;
      return { ...state, portions: Math.max(MIN_PORTIONS, action.portions) };

    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
