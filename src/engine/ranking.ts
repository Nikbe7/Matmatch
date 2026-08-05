import type { DietaryFlag } from "../schema/allergyDietary.js";
import type { CostTier } from "../schema/ingredient.js";
import type { Familiarity, PrepTimeBand, RecipeTemplate } from "../schema/recipeTemplate.js";
import type { CandidateTemplate } from "./candidates.js";
import type { EngineData } from "./data.js";

// Second slice of the Meal Engine: order the safe candidate set produced by
// selectCandidateTemplates. Deterministic, pure, no I/O and no AI — the same
// function serves the Tonight card (§4, one unambiguous pick) and the guided
// flow's ordered list (§5), so the two can never disagree about ordering.

/**
 * The session-scoped weight vector from DECISION_LOG 2026-07-31 ("Rejected
 * user-facing priority sliders"). Mutated only by adjustment-chip taps elsewhere,
 * never persisted to the household profile and never surfaced as a settings screen.
 *
 * Deliberately has no health/nutrition field: that decision excludes nutrition
 * priorities from the weight vector entirely, not just from the UI. Do not add one
 * for symmetry.
 *
 * Values are expected to be finite and non-negative. This module does not validate
 * or clamp them — chip semantics (how far a "cheaper" tap moves `cost`) belong to
 * the caller, not here.
 */
export interface RankingWeights {
  cost: number;
  time: number;
}

export interface RankedCandidate extends CandidateTemplate {
  score: number;
}

// Only the ingredient catalog is needed for seasonality; narrowing the parameter
// keeps unit tests cheap to construct, as with AllergenResolutionData.
export type SeasonalityData = Pick<EngineData, "ingredientsById">;

const COST_TIER_INDEX: Readonly<Record<CostTier, number>> = {
  budget: 0,
  mid: 1,
  premium: 2,
};

const PREP_TIME_INDEX: Readonly<Record<PrepTimeBand, number>> = {
  "<20min": 0,
  "20-40min": 1,
  "40min+": 2,
};

const FAMILIARITY_INDEX: Readonly<Record<Familiarity, number>> = {
  everyday: 0,
  occasional: 1,
  adventurous: 2,
};

/** Ordinal view of the curated cost-tier enum: budget 0, mid 1, premium 2. */
export function costTierIndex(tier: CostTier): number {
  return COST_TIER_INDEX[tier];
}

/** Ordinal view of the prep-time band enum: <20min 0, 20-40min 1, 40min+ 2. */
export function prepTimeIndex(band: PrepTimeBand): number {
  return PREP_TIME_INDEX[band];
}

/** Ordinal view of the authored familiarity enum: everyday 0, occasional 1, adventurous 2. */
export function familiarityIndex(familiarity: Familiarity): number {
  return FAMILIARITY_INDEX[familiarity];
}

// Maximum score improvement a fully in-season template can earn. Not user-adjustable
// — there is no seasonality chip, and unlike cost and time it is not something the
// household expressed a preference about, so it must not compete with one.
//
// Chosen at 0.25 because the smallest possible *expressed* preference gap is one
// enum step, worth `weights.cost` (or `weights.time`) exactly. At any weight above
// 0.25 — and chip taps are expected to move weights on the order of 1 — a full
// seasonality swing (0% to 100% of slots in season) cannot outrank a single
// cost-tier or prep-band step. So seasonality orders templates *within* a
// cost/time band and never overrides a real preference. When the household has
// expressed nothing at all (weights at or near 0), it becomes the sole ordering
// signal, which is exactly the zero-input Tonight behavior UX_FLOW §9 describes for
// a new user with no history: "season + popularity + declared preferences only."
const SEASONALITY_WEIGHT = 0.25;

// Penalty per familiarity step (everyday -> occasional -> adventurous), added to
// the score so unusual dishes rank below ordinary ones by default. Unlike
// seasonality, this is deliberately calibrated to sit *above* a single expressed
// cost/time preference step, not below it — the ranking gap it corrects
// (musselgryta beating köttbullar on a household that only asked for "cheaper")
// is a familiarity problem, not a seasonality-sized one.
//
// Chosen at 1.5, calibrated against a chip-raised weight of 1 rather than
// `DEFAULT_WEIGHTS` (src/api/weights.ts) — the default is now `{ cost: 0, time: 0 }`
// precisely so a household that has tapped nothing gets no cost/time penalty at
// all, which would make "calibrated against the default" meaningless. The first
// "cheaper" or "faster" chip tap is expected to move a weight to 1 (see
// src/api/weights.ts and the RankingWeights doc comment); at that weight, one
// familiarity step (1.5) already beats one cost-tier or prep-band step (1 * 1),
// and a full two-step gap (adventurous vs. everyday, 3.0) beats two. At 0.5 a
// two-step gap would only tie a single cost-tier step, letting a budget
// adventurous dish still outrank a mid everyday one — the exact failure this
// constant exists to fix. It is still not unbeatable: a chip that pushes cost or
// time weight to 3 or more makes that expressed preference dominate a
// familiarity gap again, same as the seasonality constant is designed to yield to
// a real preference. If the chip-tap increment ever changes, re-derive this
// constant against the new increment rather than leaving it calibrated to a
// stale value.
//
// `WEIGHT_LEVELS` in web/src/refinement.ts hardcodes its two active chip levels as
// `[0, 1, 3]`, calibrated against this constant (1 = "loses to one familiarity
// step", 3 = `FAMILIARITY_STEP_WEIGHT * 2` = "beats the largest possible
// familiarity gap") — not imported, because that module's type-only imports pull
// in this file's Node-only dependencies through tsc -b's type graph, which web/'s
// browser tsconfig cannot resolve. Re-derive that literal by hand if this value
// changes.
const FAMILIARITY_STEP_WEIGHT = 1.5;

// Penalty applied to a template tagged `vegetarian` or `vegan` when the household
// has declared neither flag. One familiarity step (not a filter, and not the full
// seasonality-beating weight of two steps): an omnivore household eats meat most
// days but not every day, so a vegetarian dish should have to be otherwise better
// — cheaper, more in season, more familiar — to win, not be excluded outright. A
// household that has declared `vegetarian` or `vegan` gets no penalty at all.
const OMNIVORE_PREFERENCE_WEIGHT = FAMILIARITY_STEP_WEIGHT;

/**
 * The ingredient actually eaten in each slot: the substitute where the filtering
 * slice rescued the slot, otherwise the template's own ingredient.
 */
function effectiveIngredientIds(candidate: CandidateTemplate): string[] {
  const substituteBySlotIndex = new Map(
    candidate.substitutions.map((substitution) => [
      substitution.slot_index,
      substitution.substitute_ingredient_id,
    ]),
  );

  return candidate.template.ingredient_slots.map(
    (slot, index) => substituteBySlotIndex.get(index) ?? slot.ingredient_id,
  );
}

/**
 * Fraction of a candidate's slots whose ingredient is in season in `month`, where
 * in-season means `available_year_round` or `month` is one of its `peak_months`.
 *
 * An ingredient absent from the catalog counts as out of season — the engine cannot
 * claim seasonality for something it cannot resolve. (The filtering slice already
 * excludes such templates outright; this is a local fallback, not a second policy.)
 */
export function inSeasonFraction(
  data: SeasonalityData,
  candidate: CandidateTemplate,
  month: number,
): number {
  const ingredientIds = effectiveIngredientIds(candidate);
  if (ingredientIds.length === 0) return 0;

  const inSeason = ingredientIds.filter((ingredientId) => {
    const ingredient = data.ingredientsById.get(ingredientId);
    if (!ingredient) return false;
    return ingredient.available_year_round || ingredient.peak_months.includes(month);
  });

  return inSeason.length / ingredientIds.length;
}

/**
 * A candidate's score — lower is better.
 *
 * `template.cost_tier` is used exactly as stored, including for candidates rescued
 * by a substitution. The effective cost tier of a swapped meal is still explicitly
 * undefined (DECISION_LOG 2026-08-01, the swap-drift section); ranking a swapped
 * meal is not the same as rendering a tier for it, so this slice does not resolve
 * that question either.
 *
 * `householdDietaryFlags` is the household's own declared flags (§5.2), used only
 * to decide whether the omnivore preference applies — it is never a filter here;
 * `selectCandidateTemplates` already decides what is safe to show at all.
 */
export function scoreCandidate(
  data: SeasonalityData,
  candidate: CandidateTemplate,
  weights: RankingWeights,
  month: number,
  householdDietaryFlags: readonly DietaryFlag[] = [],
): number {
  const costPenalty = costTierIndex(candidate.template.cost_tier) * weights.cost;
  const timePenalty = prepTimeIndex(candidate.template.prep_time_band) * weights.time;
  const seasonalityBonus = inSeasonFraction(data, candidate, month) * SEASONALITY_WEIGHT;
  const familiarityPenalty =
    familiarityIndex(candidate.template.familiarity) * FAMILIARITY_STEP_WEIGHT;

  const householdIsVegetarianOrVegan =
    householdDietaryFlags.includes("vegetarian") || householdDietaryFlags.includes("vegan");
  const templateIsVegetarianOrVegan =
    candidate.template.dietary_tags.includes("vegetarian") ||
    candidate.template.dietary_tags.includes("vegan");
  const omnivorePenalty =
    templateIsVegetarianOrVegan && !householdIsVegetarianOrVegan ? OMNIVORE_PREFERENCE_WEIGHT : 0;

  return costPenalty + timePenalty - seasonalityBonus + familiarityPenalty + omnivorePenalty;
}

function compareTemplateIds(a: RecipeTemplate, b: RecipeTemplate): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Every candidate, ordered best-first by score.
 *
 * Does not mutate the input array or any candidate in it.
 */
export function rankCandidates(
  data: SeasonalityData,
  candidates: readonly CandidateTemplate[],
  weights: RankingWeights,
  month: number,
  householdDietaryFlags: readonly DietaryFlag[] = [],
): RankedCandidate[] {
  const scored = candidates.map((candidate) => ({
    ...candidate,
    score: scoreCandidate(data, candidate, weights, month, householdDietaryFlags),
  }));

  return scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;

    // Tie-break on template id: a deterministic placeholder, NOT a quality signal —
    // nothing about a lexicographically earlier id makes a meal better. It exists so
    // Tonight never flip-flops between runs for the same household, weights and
    // month, which would read as the app being indecisive. The real tie-break is
    // repeat-avoidance (UX_FLOW §4, §9), which needs persisted history and therefore
    // the still-open DB decision (DECISION_LOG 2026-07-28); the priorities entry's
    // revisit trigger (DECISION_LOG 2026-07-31, cohort data showing repeated
    // redirects) is what should replace this rule rather than extend it.
    return compareTemplateIds(a.template, b.template);
  });
}

/**
 * The next Tonight suggestion out of an already-ranked list, given what has been
 * shown already (`excludedTemplateIds`) and what was just rejected
 * (`previousTemplate`, or `undefined` on a first request).
 *
 * Selection rule, in order: drop every excluded candidate; among what remains,
 * prefer the best-scoring candidate whose `protein_group` differs from
 * `previousTemplate`'s, and whose `cuisine` also differs if such a candidate
 * exists; fall back to the best-scoring candidate with just a different
 * `protein_group`; fall back further to the best-scoring remaining candidate.
 * `ranked` is assumed best-first (rankCandidates' output), so `.find` on it is
 * itself a "best-scoring that matches" search — no extra sort needed here.
 *
 * Returns `undefined` when nothing remains after exclusion — the caller decides
 * what that means, this function does not special-case it.
 */
export function pickNextSuggestion(
  ranked: readonly RankedCandidate[],
  excludedTemplateIds: ReadonlySet<string>,
  previousTemplate: RecipeTemplate | undefined,
): RankedCandidate | undefined {
  const remaining = ranked.filter((candidate) => !excludedTemplateIds.has(candidate.template.id));
  if (remaining.length === 0) return undefined;
  if (previousTemplate === undefined) return remaining[0];

  const differentProteinAndCuisine = remaining.find(
    (candidate) =>
      candidate.template.protein_group !== previousTemplate.protein_group &&
      candidate.template.cuisine !== previousTemplate.cuisine,
  );
  if (differentProteinAndCuisine) return differentProteinAndCuisine;

  const differentProtein = remaining.find(
    (candidate) => candidate.template.protein_group !== previousTemplate.protein_group,
  );
  if (differentProtein) return differentProtein;

  return remaining[0];
}

/**
 * The single meal for the Tonight card (UX_FLOW §4), or `undefined` when the
 * household has no safe candidates at all.
 *
 * Deliberately a thin wrapper over rankCandidates + pickNextSuggestion rather than
 * its own selection logic: Tonight is the top of the same order the guided flow
 * shows (no exclusions, no previous pick), so the two cannot drift apart.
 */
export function pickTonight(
  data: SeasonalityData,
  candidates: readonly CandidateTemplate[],
  weights: RankingWeights,
  month: number,
  householdDietaryFlags: readonly DietaryFlag[] = [],
): RankedCandidate | undefined {
  const ranked = rankCandidates(data, candidates, weights, month, householdDietaryFlags);
  return pickNextSuggestion(ranked, new Set(), undefined);
}
