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
 * The weight a "Billigare"/"Snabbare" chip carries at each of its levels — level 0
 * is off. Two active levels, not five: `cost_tier` and `prep_time_band` each have
 * three values, so the only ranking-relevant weight thresholds are "beats one
 * familiarity step" and "beats the largest possible familiarity gap (two steps)".
 *
 * Level 1 = 1: the smallest expressed preference, calibrated to lose to a single
 * `FAMILIARITY_STEP_WEIGHT` step (`src/engine/ranking.ts`, currently 1.5) — a
 * household that taps once is nudging the order, not overriding it.
 *
 * Level 2 = 3, i.e. `FAMILIARITY_STEP_WEIGHT * 2`: enough to beat even the largest
 * familiarity gap (adventurous vs. everyday, two steps), so the expressed
 * preference dominates. Not imported from `src/engine/ranking.ts` — that module's
 * type-only imports pull in `src/engine/data.ts`'s `node:fs`/`node:url` usage
 * through `tsc -b`'s type graph, which `web/`'s browser tsconfig (no `node` types)
 * cannot resolve. If `FAMILIARITY_STEP_WEIGHT` is ever re-derived, re-derive this
 * literal (`FAMILIARITY_STEP_WEIGHT * 2`) alongside it — do not let it drift stale.
 *
 * Levels 4 and 5 of the old five-level scale produced no observable change in
 * ranking order — see DECISION_LOG 2026-08-05 — so this is the full range now.
 */
export const WEIGHT_LEVELS = [0, 1, 3] as const;

/** The highest level a chip can cycle to (index into `WEIGHT_LEVELS`). */
export const MAX_WEIGHT_LEVEL = WEIGHT_LEVELS.length - 1;

export type WeightAxis = "cost" | "time";

/** Chip identity as it appears in analytics — stable, never the Swedish label. */
export type ChipId = "cheaper" | "faster" | "other_cuisine" | "something_else" | "reset";

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
}

export const INITIAL_REFINEMENT: RefinementState = {
  weights: { cost: 0, time: 0 },
  excludedTemplateIds: [],
  rerollDepth: 0,
};

export type RefinementAction =
  /** A chip that re-requests without changing the weight vector. */
  | { type: "reroll"; chip: Extract<ChipId, "something_else" | "other_cuisine"> }
  /** "Billigare" / "Snabbare": cycles one axis 0 → 1 → 2 → 0. */
  | { type: "increment"; axis: WeightAxis }
  /** A suggestion reached the screen — it must not come back this session. */
  | { type: "suggestion_shown"; templateId: string }
  /** Templates ruled out while searching for a different cuisine. */
  | { type: "exclude_templates"; templateIds: readonly string[] }
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
    case "increment": {
      const currentLevel = weightLevel(state, action.axis);
      const nextLevel = (currentLevel + 1) % WEIGHT_LEVELS.length;
      return {
        ...state,
        weights: {
          ...state.weights,
          [action.axis]: WEIGHT_LEVELS[nextLevel],
        },
        rerollDepth: state.rerollDepth + 1,
      };
    }

    case "reroll":
      return { ...state, rerollDepth: state.rerollDepth + 1 };

    case "suggestion_shown":
      return withExcluded(state, [action.templateId]);

    case "exclude_templates":
      return withExcluded(state, action.templateIds);

    case "reset":
      // Weights and exclusions to defaults; reroll depth deliberately survives.
      return { ...INITIAL_REFINEMENT, rerollDepth: state.rerollDepth + 1 };

    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/** The 0–`MAX_WEIGHT_LEVEL` level a chip renders, for the dot meter and its accessible name. */
export function weightLevel(state: RefinementState, axis: WeightAxis): number {
  return WEIGHT_LEVELS.indexOf(state.weights[axis] as (typeof WEIGHT_LEVELS)[number]);
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
