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

// Repeat-avoidance (issue #88, UX_FLOW §4 "avoiding repeats"). Penalty for a template
// this household cooked recently, decaying linearly to nothing over the window below.
// A *penalty*, never a filter: a hard exclusion empties the candidate set for exactly
// the constrained households `selectCandidateTemplates` is careful to keep options for
// (all 8 allergies + vegan leaves 14 of ~170 templates), and an empty Tonight is the
// dead end UX_FLOW §9 forbids. Cooking the same dish twice in a fortnight is a
// preference, not a safety rule — so it belongs in the score, where something better
// can outweigh it.
//
// Chosen at 5.0, bounded on both sides by the constants above:
//
//  * Above 4.75 — the entire score spread available at `DEFAULT_WEIGHTS`
//    (src/api/weights.ts, `{cost: 0, time: 0}`), which is two familiarity steps
//    (2 * 1.5 = 3.0) plus the omnivore preference (1.5) plus a full seasonality swing
//    (0.25). Anything above that total guarantees a dish cooked *tonight* ranks below
//    EVERY uncooked candidate for a household that has tapped no chips — which is the
//    bug this exists to fix (open the app three evenings running, get the same dish
//    three times). Below 4.75 it would merely be a nudge, and an adventurous
//    vegetarian dish could still lose to the meal cooked yesterday.
//  * Below 6.0 — one maxed adjustment chip (`WEIGHT_LEVELS` level 2 = weight 3, see
//    web/src/refinement.ts) across a two-step cost-tier or prep-band gap. Staying
//    under it keeps repeat-avoidance beatable by the strongest preference a household
//    can actually express, the same yield-to-a-real-preference property
//    SEASONALITY_WEIGHT and FAMILIARITY_STEP_WEIGHT are both calibrated for: a
//    household that taps "Billigare" to max and means it can still be shown last
//    night's cheap dish over an expensive new one.
//
// If FAMILIARITY_STEP_WEIGHT, OMNIVORE_PREFERENCE_WEIGHT, SEASONALITY_WEIGHT or the
// chip levels change, re-derive both bounds and re-pick this value inside the new band
// rather than leaving it calibrated to stale numbers.
const RECENCY_PENALTY_WEIGHT = 5.0;

// How long a cooked meal keeps depressing its own score. Fourteen days for two
// reasons. First, the decay step: 5.0 / 14 ≈ 0.36 of score per day elapsed, just above
// SEASONALITY_WEIGHT (0.25), so among several recently cooked dishes one extra day of
// staleness outweighs a full seasonality swing — the ordering inside the recently-cooked
// group is by recency rather than by seasonality noise. A much longer window would
// invert that. Second, two weeks is roughly one household's whole dinner rotation, so a
// dish is back at full standing about when it stops feeling repetitive.
//
// Beyond the window the penalty is exactly 0, not a small residue: a template cooked
// three weeks ago competes on its merits. Recency still breaks *ties* past the window
// (see rankCandidates), which is where old history keeps a say without distorting scores.
const RECENCY_WINDOW_DAYS = 14;

/** The penalty window, in days, so callers can bound the history they load. */
export const RECENCY_HISTORY_WINDOW_DAYS = RECENCY_WINDOW_DAYS;

/**
 * When each template was most recently cooked by this household: template id → the
 * latest `cooked_at`. A map, not a row list, because the score depends only on the most
 * recent cooking of a given dish — how *often* it has been cooked is deliberately not a
 * signal (that would be preference learning, out of scope for #88).
 */
export type CookingHistory = ReadonlyMap<string, Date>;

/**
 * History plus the instant to measure it against.
 *
 * `now` is a parameter for the same reason `month` is: src/engine/ stays pure and never
 * reads the clock itself, so the route supplies both. Bundled with the history rather
 * than added as a seventh positional parameter — and optional throughout, so a caller
 * with no history (the guided flow, every existing test) passes nothing and gets the
 * pre-#88 behaviour exactly.
 */
export interface RecencyContext {
  history: CookingHistory;
  now: Date;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Most recent cooking per template, from rows in any order.
 *
 * Takes the plain `{ template_id, cooked_at }` shape the repository returns rather than
 * importing a database type — the engine takes history as data, exactly as it takes
 * SeasonalityData.
 */
export function buildCookingHistory(
  rows: readonly { template_id: string; cooked_at: Date }[],
): CookingHistory {
  const latest = new Map<string, Date>();

  for (const row of rows) {
    const known = latest.get(row.template_id);
    if (!known || row.cooked_at > known) latest.set(row.template_id, row.cooked_at);
  }

  return latest;
}

/**
 * Whole days elapsed since `cookedAt`, floored — so a score is stable for a whole day
 * and does not drift minute to minute while a household is looking at the card.
 *
 * A `cooked_at` in the future (clock skew between the database and this process) floors
 * to 0, i.e. treated as just cooked, rather than producing a negative day count that
 * would turn the penalty into a bonus.
 */
function daysSince(cookedAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - cookedAt.getTime()) / MILLISECONDS_PER_DAY));
}

/**
 * The repeat-avoidance penalty for `templateId`: RECENCY_PENALTY_WEIGHT on the day it
 * was cooked, decaying linearly to 0 at RECENCY_WINDOW_DAYS, and 0 for a template with
 * no history at all.
 */
export function recencyPenalty(templateId: string, recency: RecencyContext): number {
  const cookedAt = recency.history.get(templateId);
  if (!cookedAt) return 0;

  const elapsed = daysSince(cookedAt, recency.now);
  if (elapsed >= RECENCY_WINDOW_DAYS) return 0;

  return RECENCY_PENALTY_WEIGHT * (1 - elapsed / RECENCY_WINDOW_DAYS);
}

/**
 * The ingredient actually eaten in each slot: the substitute where the filtering
 * slice rescued the slot, otherwise the template's own ingredient.
 *
 * Exported for `directions.ts`, which asks the same question of a candidate ("what
 * is actually in this dish") to match a main ingredient and pantry input. One
 * definition, so a swapped slot can never count as in-season here and as the
 * original ingredient there.
 */
export function effectiveIngredientIds(candidate: CandidateTemplate): string[] {
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
 *
 * `recency` is optional: omitted (no persisted history, or a caller that does not load
 * it) means no repeat-avoidance penalty, not a penalty of zero days.
 */
/**
 * Every additive term `scoreCandidate` sums, kept apart so `explainSuggestion` below
 * can compare two candidates term-by-term without a second, parallel computation of
 * the same score — the one thing requirement 3 (#122) forbids is a description that
 * can drift from the ranking it describes.
 */
interface ScoreBreakdown {
  costPenalty: number;
  timePenalty: number;
  seasonalityBonus: number;
  familiarityPenalty: number;
  omnivorePenalty: number;
  repeatPenalty: number;
}

function scoreBreakdown(
  data: SeasonalityData,
  candidate: CandidateTemplate,
  weights: RankingWeights,
  month: number,
  householdDietaryFlags: readonly DietaryFlag[],
  recency?: RecencyContext,
): ScoreBreakdown {
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

  const repeatPenalty = recency ? recencyPenalty(candidate.template.id, recency) : 0;

  return { costPenalty, timePenalty, seasonalityBonus, familiarityPenalty, omnivorePenalty, repeatPenalty };
}

export function scoreCandidate(
  data: SeasonalityData,
  candidate: CandidateTemplate,
  weights: RankingWeights,
  month: number,
  householdDietaryFlags: readonly DietaryFlag[] = [],
  recency?: RecencyContext,
): number {
  const b = scoreBreakdown(data, candidate, weights, month, householdDietaryFlags, recency);
  return b.costPenalty + b.timePenalty - b.seasonalityBonus + b.familiarityPenalty + b.omnivorePenalty + b.repeatPenalty;
}

function compareTemplateIds(a: RecipeTemplate, b: RecipeTemplate): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Least-recently-cooked first among candidates with identical scores: never cooked
 * beats cooked at all, and older beats newer.
 *
 * This is a *tie-break*, doing work the penalty cannot. The penalty is quantised to
 * whole days (deliberately — see daysSince), so two dishes cooked on the *same* day
 * carry an identical penalty and tie on score; this orders them by the actual hour they
 * were cooked. It also decides between a within-history dish whose penalty has decayed
 * to 0 and one never cooked at all, which score identically by construction. Returns 0
 * when both were cooked at the same instant, leaving the id fallback to decide.
 */
function compareByLeastRecentlyCooked(
  a: RecipeTemplate,
  b: RecipeTemplate,
  recency: RecencyContext,
): number {
  const cookedA = recency.history.get(a.id);
  const cookedB = recency.history.get(b.id);

  if (!cookedA && !cookedB) return 0;
  if (!cookedA) return -1;
  if (!cookedB) return 1;

  return cookedA.getTime() - cookedB.getTime();
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
  recency?: RecencyContext,
): RankedCandidate[] {
  const scored = candidates.map((candidate) => ({
    ...candidate,
    score: scoreCandidate(data, candidate, weights, month, householdDietaryFlags, recency),
  }));

  return scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;

    // Repeat-avoidance is the real tie-break (UX_FLOW §4, §9), and since #88 there is
    // persisted history to do it with: least recently cooked first, never-cooked ahead
    // of cooked. This replaces the template-id rule that stood here as a placeholder
    // for exactly this.
    if (recency) {
      const byRecency = compareByLeastRecentlyCooked(a.template, b.template, recency);
      if (byRecency !== 0) return byRecency;
    }

    // Template id remains the last resort, and only that: it is NOT a quality signal —
    // nothing about a lexicographically earlier id makes a meal better. It exists so
    // Tonight never flip-flops between runs for the same household, weights, month and
    // history, which would read as the app being indecisive. Two candidates reaching
    // here are equally scored and equally recently cooked (or both never cooked), so
    // *something* deterministic has to choose, and this is it.
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
 * itself a "best-scoring that matches" search — no extra sort needed here. That
 * ordering already carries repeat-avoidance, both as the recency penalty in the score
 * and as the least-recently-cooked tie-break, so this function needs no history of its
 * own: keeping one ordering source of truth in rankCandidates is what stops Tonight and
 * the guided flow from disagreeing about what "next" means.
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
  recency?: RecencyContext,
): RankedCandidate | undefined {
  const ranked = rankCandidates(data, candidates, weights, month, householdDietaryFlags, recency);
  return pickNextSuggestion(ranked, new Set(), undefined);
}

// Fourth slice, #122: why the Tonight card shows this dish. An enum, not free text
// (implementation notes), so the set is reviewable and the client's phrasing is one
// lookup — this module only ever hands back codes plus which candidates they were
// derived from, never a sentence.
export type SuggestionReasonCode =
  | "in_season"
  | "not_recently_cooked"
  | "cost_preference"
  | "time_preference"
  | "different_from_last_time";

/** UX_FLOW §4: at most two reasons on the card, never a list. */
const MAX_SUGGESTION_REASONS = 2;

/**
 * "Different protein than last time" is true whenever it's true — it does not
 * matter whether `pickNextSuggestion`'s diversity rule was the branch that actually
 * fired or the top-scored candidate already happened to differ. Either way the
 * household is being told a fact about the dish on screen, not a claim about which
 * line of code produced it.
 */
function varietyReason(
  picked: RankedCandidate,
  previousTemplate: RecipeTemplate | undefined,
): SuggestionReasonCode | undefined {
  if (!previousTemplate) return undefined;
  return picked.template.protein_group !== previousTemplate.protein_group
    ? "different_from_last_time"
    : undefined;
}

/**
 * Score-term reasons, derived by comparing `picked` against the best-scoring
 * candidate that would have been shown in its place (`runnerUp`) — "why this dish"
 * only means something relative to the alternative, exactly as the score itself only
 * ever decides an *order*. A term "dominates" when it is among the two largest
 * positive gaps out of every term the score has, named or not (familiarity and the
 * omnivore preference have no user-facing phrasing yet — see requirement 2, #122).
 * Landing in the top two but being unnamed silently costs that slot rather than
 * falling through to a smaller, nameable gap: requirement 5 forbids crediting a term
 * that did not actually drive the difference between this dish and the alternative.
 */
function scoreTermReasons(
  data: SeasonalityData,
  picked: RankedCandidate,
  runnerUp: RankedCandidate,
  weights: RankingWeights,
  month: number,
  householdDietaryFlags: readonly DietaryFlag[],
  recency: RecencyContext | undefined,
): SuggestionReasonCode[] {
  const pickedTerms = scoreBreakdown(data, picked, weights, month, householdDietaryFlags, recency);
  const runnerUpTerms = scoreBreakdown(data, runnerUp, weights, month, householdDietaryFlags, recency);

  const diffs: { code: SuggestionReasonCode | undefined; diff: number }[] = [
    { code: "in_season", diff: pickedTerms.seasonalityBonus - runnerUpTerms.seasonalityBonus },
    { code: "cost_preference", diff: runnerUpTerms.costPenalty - pickedTerms.costPenalty },
    { code: "time_preference", diff: runnerUpTerms.timePenalty - pickedTerms.timePenalty },
    { code: "not_recently_cooked", diff: runnerUpTerms.repeatPenalty - pickedTerms.repeatPenalty },
    { code: undefined, diff: runnerUpTerms.familiarityPenalty - pickedTerms.familiarityPenalty },
    { code: undefined, diff: runnerUpTerms.omnivorePenalty - pickedTerms.omnivorePenalty },
  ];

  return diffs
    .filter((entry) => entry.diff > 1e-9)
    .sort((a, b) => b.diff - a.diff)
    .slice(0, MAX_SUGGESTION_REASONS)
    .map((entry) => entry.code)
    .filter((code): code is SuggestionReasonCode => code !== undefined);
}

/**
 * The reason codes for the dish `pickNextSuggestion` chose, or `[]` when nothing
 * meaningfully dominated — silence is correct output, not a missing case (#122).
 *
 * `ranked` and `excludedTemplateIds` are the same arguments the caller already
 * passed to `pickNextSuggestion`, so the comparison candidate here is the same
 * candidate that function would have returned in `picked`'s place — never a
 * candidate that was already excluded, and never a re-derivation of the ranking.
 */
export function explainSuggestion(
  data: SeasonalityData,
  ranked: readonly RankedCandidate[],
  excludedTemplateIds: ReadonlySet<string>,
  picked: RankedCandidate,
  previousTemplate: RecipeTemplate | undefined,
  weights: RankingWeights,
  month: number,
  householdDietaryFlags: readonly DietaryFlag[] = [],
  recency?: RecencyContext,
): readonly SuggestionReasonCode[] {
  const reasons: SuggestionReasonCode[] = [];

  const variety = varietyReason(picked, previousTemplate);
  if (variety) reasons.push(variety);

  const remaining = ranked.filter((candidate) => !excludedTemplateIds.has(candidate.template.id));
  const topScored = remaining[0];

  // `pickNextSuggestion`'s protein/cuisine diversity rule can hand back a candidate
  // that is *not* the best-scoring one remaining — that is the whole point of the
  // rule. When it does, the score did not decide `picked` over `topScored`; variety
  // did. Crediting a score term in that case (e.g. "cheaper" because `picked` happens
  // to have a lower cost tier than the candidate the score preferred) would be true
  // about the two dishes in isolation but false about what drove the decision —
  // exactly what requirement 5 forbids. Score-term reasons only make sense to compute
  // at all when `picked` *is* the plain score winner among what remains.
  const scoreDecidedThisPick = topScored !== undefined && topScored.template.id === picked.template.id;

  if (scoreDecidedThisPick && reasons.length < MAX_SUGGESTION_REASONS) {
    const runnerUp = remaining.find((candidate) => candidate.template.id !== picked.template.id);

    if (runnerUp) {
      for (const code of scoreTermReasons(
        data,
        picked,
        runnerUp,
        weights,
        month,
        householdDietaryFlags,
        recency,
      )) {
        if (reasons.length >= MAX_SUGGESTION_REASONS) break;
        if (!reasons.includes(code)) reasons.push(code);
      }
    }
  }

  return reasons;
}
