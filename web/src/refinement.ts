import type { Cuisine } from "../../src/schema/recipeTemplate";
import type { SessionWeights, TonightResponse } from "./api";

// Session refinement state for the Tonight card's adjustment chips (UX_FLOW §4/§5
// step 5, DECISION_LOG 2026-07-31, the 2026-08-05 chip entry and the 2026-08-05
// level-calibration entry). One reducer rather than four useStates because every
// chip mutates the same session object: a tap changes weights, the exclusion set
// and the reroll depth together, and they must never drift apart.
//
// Nothing here is persisted. There is deliberately no load/save pair the way
// shoppingListStorage.ts has one — refinements are session-scoped by decision, not
// by omission, so adding persistence would be reversing a decision rather than
// filling a gap.

/**
 * What a "Billigare"/"Snabbare" chip sets its axis to when tapped on — 0 is off.
 *
 * Binary since 2026-08-23 (DECISION_LOG), superseding the 2026-08-05 two-level
 * calibration on level count: that entry's own "level 1" (35 notches) was
 * deliberately calibrated to *lose* to a single `NEUTRAL_FAMILIARITY_STEP_WEIGHT`
 * step, so a household's first tap could visibly change nothing about the
 * suggestion — the same "does nothing" failure the 2026-08-05 entry itself used to
 * kill levels 4 and 5. That nudge-level job now belongs to the persistent
 * Pris/Tid/Variation/Enkelhet sliders (2026-08-16); a chip is a statement about
 * tonight, not a dial, so one tap sets the axis all the way on and the second tap
 * turns it off.
 *
 * Expressed in SLIDER NOTCHES (0–100, step 5) since #157: the chip and the
 * household's persistent slider move the same axis in the same units, and the
 * server combines the two (`combinePreferenceWeights`) instead of holding two ideas
 * of what "cheaper" means. `WEIGHT_ON = 100` → engine weight 3, exactly
 * `NEUTRAL_FAMILIARITY_STEP_WEIGHT * 2`: enough to beat even the largest
 * familiarity gap (adventurous vs. everyday, two steps), so the expressed
 * preference dominates. Also exactly `MAX_CHIP_PREFERENCE` in
 * `src/api/guidedIntent.ts`, whose own comment already argued for starting the
 * guided flow's "Billigt" intent chip at full strength rather than a timid level 1
 * — binary-at-100 makes both chip surfaces mean the same thing on the same axis.
 *
 * Not derived from `src/engine/ranking.ts` — that module's type-only imports pull
 * in `src/engine/data.ts`'s `node:fs`/`node:url` usage through `tsc -b`'s type
 * graph, which `web/`'s browser tsconfig (no `node` types) cannot resolve. If
 * `NEUTRAL_FAMILIARITY_STEP_WEIGHT` or `MAX_AXIS_RANKING_WEIGHT` is ever
 * re-derived, re-derive this literal (and `MAX_CHIP_PREFERENCE`) alongside them —
 * do not let them drift stale.
 */
export const WEIGHT_ON = 100;

/**
 * The axes a chip can nudge. `variation` joined price/time with "Testa nytt" (#153),
 * and `simplicity` joins them now with "Enklare" (#153, gated on #151's curated
 * effort_level) — the same axis the Enkelhet slider moves, in the same notches, so
 * every chip is a session delta on the household's baseline rather than a second idea
 * of the same preference.
 */
export type WeightAxis = "price" | "time" | "variation" | "simplicity";

/** Chip identity as it appears in analytics — stable, never the Swedish label. */
export type ChipId =
  | "cheaper"
  | "faster"
  | "try_new"
  | "simpler"
  | "other_cuisine"
  | "something_else"
  | "reset"
  | "pantry";

export interface RefinementState {
  weights: SessionWeights;
  /**
   * Everything shown so far this session, plus anything a cuisine rejection ruled
   * out. Sent as `exclude` on the next request; never read from or written to
   * storage.
   */
  excludedTemplateIds: readonly string[];
  /**
   * How many refinement taps this session has taken. Cumulative across a
   * "Återställ" — reset restores the *suggestion*, but the friction the household
   * already went through is exactly the signal Phase 2 needs, so it is not zeroed.
   */
  rerollDepth: number;
  /**
   * What the household tapped on Tonight's pantry row (#152) — ordering input, never a
   * rejection and never an inventory.
   *
   * Lives in this reducer rather than beside it because a pantry tap and a chip tap
   * both produce the same next request, and two pieces of state feeding one request is
   * how they drift. Session-scoped exactly like the rest of this file: React state
   * only, nothing to localStorage, the URL or the household profile, so a reload starts
   * empty.
   */
  pantryIngredientIds: readonly string[];
}

export const INITIAL_REFINEMENT: RefinementState = {
  weights: { price: 0, time: 0, variation: 0, simplicity: 0 },
  excludedTemplateIds: [],
  rerollDepth: 0,
  pantryIngredientIds: [],
};

export type RefinementAction =
  /** A chip that re-requests without changing the weight vector. */
  | { type: "reroll"; chip: Extract<ChipId, "something_else" | "other_cuisine"> }
  /** "Billigare" / "Snabbare": toggles one axis between 0 and `WEIGHT_ON`. */
  | { type: "toggle_axis"; axis: WeightAxis }
  /** A suggestion reached the screen — it must not come back this session. */
  | { type: "suggestion_shown"; templateId: string }
  /** Templates ruled out while searching for a different cuisine. */
  | { type: "exclude_templates"; templateIds: readonly string[] }
  /** A pantry chip on Tonight, on or off (#152). */
  | { type: "toggle_pantry"; ingredientId: string }
  | { type: "reset" };

function withExcluded(
  state: RefinementState,
  templateIds: readonly string[],
  rerollDepth = state.rerollDepth,
): RefinementState {
  const merged = new Set([...state.excludedTemplateIds, ...templateIds]);
  if (merged.size === state.excludedTemplateIds.length && rerollDepth === state.rerollDepth) {
    return state;
  }
  return { ...state, excludedTemplateIds: [...merged], rerollDepth };
}

export function refinementReducer(
  state: RefinementState,
  action: RefinementAction,
): RefinementState {
  switch (action.type) {
    case "toggle_axis": {
      const isOn = isAxisActive(state, action.axis);
      return {
        ...state,
        weights: {
          ...state.weights,
          [action.axis]: isOn ? 0 : WEIGHT_ON,
        },
        // Increments either direction: the friction signal is the tap itself, not
        // which way it moved the axis.
        rerollDepth: state.rerollDepth + 1,
      };
    }

    case "reroll":
      return { ...state, rerollDepth: state.rerollDepth + 1 };

    case "suggestion_shown":
      return withExcluded(state, [action.templateId]);

    case "exclude_templates":
      return withExcluded(state, action.templateIds);

    case "toggle_pantry": {
      const selected = state.pantryIngredientIds.includes(action.ingredientId);
      return {
        ...state,
        pantryIngredientIds: selected
          ? state.pantryIngredientIds.filter((id) => id !== action.ingredientId)
          : [...state.pantryIngredientIds, action.ingredientId],
        rerollDepth: state.rerollDepth + 1,
      };
    }

    case "reset":
      // Weights and exclusions to defaults; reroll depth deliberately survives.
      //
      // So does the pantry. "Återställ" undoes what the household *asked for* — the
      // weights it nudged and the dishes it turned down. What is in the cupboard is not
      // a request, it is a fact they told us one tap ago, and silently forgetting it
      // would make the button destroy information the household never offered to give
      // back.
      return {
        ...INITIAL_REFINEMENT,
        rerollDepth: state.rerollDepth + 1,
        pantryIngredientIds: state.pantryIngredientIds,
      };

    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/** Whether a chip's axis is on — the chip's whole visible state (`aria-pressed`). */
export function isAxisActive(state: RefinementState, axis: WeightAxis): boolean {
  return state.weights[axis] === WEIGHT_ON;
}

/**
 * How many suggestions "Annat kök" will look at before giving up and behaving as a
 * plain reroll. Four is generous in practice: `pickNextSuggestion` already prefers
 * a candidate whose cuisine differs from `previous`, so the first request normally
 * lands a different cuisine outright, and a household that burns four in a row has
 * a candidate set genuinely dominated by one cuisine.
 */
export const MAX_CUISINE_PROBES = 4;

export interface CuisineSearchOutcome {
  /** The response to render. Never a probe the user did not see. */
  response: TonightResponse;
  /** Ids to add to the session exclusion set. */
  excludedTemplateIds: readonly string[];
}

type TonightRequest = (exclude: readonly string[], previous: string) => Promise<TonightResponse>;

/**
 * "Annat kök": find a suggestion whose cuisine differs from the one on screen.
 *
 * Resolved client-side into plain template-id exclusions, deliberately — cuisine is
 * never a request parameter (DECISION_LOG 2026-08-05). Adding one would put a new
 * filter dimension into the API and, with ~170 templates across a handful of
 * cuisines, would be a short step from a cuisine multi-select that empties the
 * library. Every same-cuisine dish the search rejects is a dish the household
 * asked not to see, so it is excluded exactly like any other rejection.
 *
 * When no different-cuisine candidate remains, this falls back to a plain reroll:
 * the first same-cuisine suggestion is rendered and only the *original* dish is
 * excluded, so the probes do not silently burn candidates the household never
 * rejected on their own merits.
 */
export async function searchOtherCuisine(
  request: TonightRequest,
  state: RefinementState,
  currentTemplateId: string,
  currentCuisine: Cuisine,
): Promise<CuisineSearchOutcome> {
  const probed = [currentTemplateId];
  const excluded = new Set([...state.excludedTemplateIds, currentTemplateId]);
  let fallback: TonightResponse | undefined;

  for (let attempt = 0; attempt < MAX_CUISINE_PROBES; attempt += 1) {
    const response = await request([...excluded], currentTemplateId);
    const result = response.result;

    // Out of candidates. If a same-cuisine one was already found, that is the
    // plain-reroll fallback; otherwise the empty state is the honest answer.
    if (result === null) {
      return fallback
        ? { response: fallback, excludedTemplateIds: [currentTemplateId] }
        : { response, excludedTemplateIds: probed };
    }

    if (result.template.cuisine !== currentCuisine) {
      return { response, excludedTemplateIds: probed };
    }

    fallback ??= response;
    probed.push(result.template.id);
    excluded.add(result.template.id);
  }

  // Reaching here means every one of MAX_CUISINE_PROBES (>= 1) responses carried a
  // result of the rejected cuisine, so `fallback` was set on the first pass.
  return { response: fallback!, excludedTemplateIds: [currentTemplateId] };
}
