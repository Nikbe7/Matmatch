import type { DietaryFlag } from "../schema/allergyDietary.js";
import {
  NEUTRAL_PREFERENCE_WEIGHTS,
  PREFERENCE_WEIGHT_MAX,
  type PreferenceWeights,
} from "../schema/preferenceWeights.js";
import type { CostTier } from "../schema/ingredient.js";
import type {
  EffortLevel,
  Familiarity,
  IngredientSlotRole,
  PrepTimeBand,
  RecipeTemplate,
} from "../schema/recipeTemplate.js";
import type { CandidateTemplate } from "./candidates.js";
import type { EngineData } from "./data.js";

// Second slice of the Meal Engine: order the safe candidate set produced by
// selectCandidateTemplates. Deterministic, pure, no I/O and no AI — the same
// function serves the Tonight card (§4, one unambiguous pick) and the guided
// flow's ordered list (§5), so the two can never disagree about ordering.

/**
 * The engine-domain weight vector: score points per enum step, calibrated against the
 * constants below. Never constructed by hand outside tests — it is *derived* from the
 * household's `PreferenceWeights` by `toRankingWeights`, which is the only bridge
 * between the two spaces (#157).
 *
 * That derivation is what keeps there from being two weight concepts. Everything a
 * household can express — the persistent slider baseline and the session-scoped chip
 * delta alike — is a `PreferenceWeights` value; this type is what the score arithmetic
 * needs after that single translation. If you find yourself adding a field here that
 * has no axis behind it, or an axis with no field here, one of the two is wrong.
 *
 * Deliberately has no health/nutrition field: DECISION_LOG 2026-07-31 excludes
 * nutrition priorities from the weight vector entirely, not just from the UI, and the
 * 2026-08-16 slider entry left that half standing. Do not add one for symmetry.
 *
 * Values are expected to be finite and non-negative. This module does not validate or
 * clamp them; `toRankingWeights` produces only in-range values from a validated
 * `PreferenceWeights`, and the range guarantee lives there and in the schema.
 */
export interface RankingWeights {
  /** Score points per cost-tier step (budget → mid → premium). */
  price: number;
  /** Score points per prep-time-band step (<20min → 20-40min → 40min+). */
  time: number;
  /**
   * Score points per familiarity step (everyday → occasional → adventurous).
   *
   * A weight since #157, a hardcoded constant before it. `NEUTRAL_FAMILIARITY_STEP_WEIGHT`
   * is the value it had, and the value it still takes at `variation: 0` — which is why
   * a household that has never touched the Variation slider ranks exactly as it did
   * before this field existed.
   */
  familiarity: number;
  /**
   * Score points per effort-level step (simple → moderate → project). Live since
   * #153, the same shape as `price` and `time`: 0 at `simplicity: 0`, rising linearly
   * to `MAX_AXIS_RANKING_WEIGHT` at `simplicity: 100`.
   */
  simplicity: number;
}

/**
 * The engine weight a maxed-out axis carries, i.e. what `100` on a slider buys.
 *
 * 3, because that is what an "on" adjustment chip has always been worth
 * (`WEIGHT_ON` in web/src/refinement.ts): enough to beat the largest possible
 * familiarity gap (two steps at `NEUTRAL_FAMILIARITY_STEP_WEIGHT`), so a household that
 * pushes an axis all the way genuinely dominates the order. Keeping the ceiling at the
 * old chip maximum is also what lets a chip be re-expressed as a slider delta without
 * changing what the strongest expressible preference does.
 */
const MAX_AXIS_RANKING_WEIGHT = 3;

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

const EFFORT_LEVEL_INDEX: Readonly<Record<EffortLevel, number>> = {
  simple: 0,
  moderate: 1,
  project: 2,
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

/** Ordinal view of the curated effort-level enum: simple 0, moderate 1, project 2. */
export function effortLevelIndex(effortLevel: EffortLevel): number {
  return EFFORT_LEVEL_INDEX[effortLevel];
}

// Maximum score improvement a fully in-season template can earn. Not user-adjustable
// — there is no seasonality axis, and unlike price and time it is not something the
// household expressed a preference about, so it must not compete with one.
//
// Chosen at 0.25 against the *pre-#157* weight scale, where the smallest expressed
// preference was a whole chip level (weight 1) and one enum step was therefore worth
// at least 1.0. Re-derived for the slider scale, the claim it used to make is now
// only true above a threshold, and it is worth being exact about where:
//
//  * One enum step is worth `weights.price` (or `weights.time`), and one slider notch
//    of 5 is worth 5/100 * MAX_AXIS_RANKING_WEIGHT = 0.15. So at notches 5 and 10
//    (weights 0.15 and 0.30) a full seasonality swing is comparable to, and at notch 5
//    larger than, a single cost-tier step.
//  * That is the intended reading, not a regression: those notches sit squarely in the
//    control's own "Spelar liten roll" band. A household saying price barely matters
//    should not have a one-tier price difference override what is actually in season.
//  * From notch 10 upward (weight >= 0.30) the original property holds again — a
//    single expressed enum step outranks the entire seasonality range — and from the
//    old level-1 chip equivalent (notch 35, weight 1.05) it is not close.
//
// So seasonality orders templates *within* a price/time band for any household that
// has meaningfully expressed something, and becomes the dominant ordering signal only
// when the household has expressed nothing at all — exactly the zero-input Tonight
// behaviour UX_FLOW §9 describes for a new user with no history: "season + popularity
// + declared preferences only."
const SEASONALITY_WEIGHT = 0.25;

// Penalty per familiarity step (everyday -> occasional -> adventurous) at
// `variation: 0`, added to the score so unusual dishes rank below ordinary ones for a
// household that has asked to stick to what it knows. Unlike seasonality, this is
// deliberately calibrated to sit *above* a single expressed price/time step at the old
// level-1 chip strength, not below it — the ranking gap it corrects (musselgryta
// beating köttbullar on a household that only asked for "cheaper") is a familiarity
// problem, not a seasonality-sized one.
//
// Chosen at 1.5, originally calibrated against a chip-raised weight of 1 rather than
// against the neutral default — the default is `NEUTRAL_PREFERENCE_WEIGHTS` (all zeros)
// precisely so a household that has expressed nothing gets no price/time penalty at all,
// which would make "calibrated against the default" meaningless. A full two-step
// familiarity gap (adventurous vs. everyday, 3.0) still beats two cost-tier/prep-band
// steps (2.10) at that calibration. It is not unbeatable: an axis pushed to 100 (weight 3,
// `MAX_AXIS_RANKING_WEIGHT`) makes an expressed preference dominate a familiarity gap
// again, the same yield-to-a-real-preference property SEASONALITY_WEIGHT has.
//
// Since 2026-08-23 the Tonight adjustment chips are binary — a tap moves an axis straight
// to notch 100 (weight 3), never to an intermediate notch — so this constant's "loses to
// one familiarity step" case is only reachable by hand-dragging a slider to a low notch,
// not by any chip. It stays 1.5 regardless: sliders still cover the full 0–100 range, and
// a household that drags Pris to notch 35 should get the same "nudge, not override"
// behaviour a chip used to express at that value.
//
// Since #157 this is a *floor value*, not the value used: `toRankingWeights` scales it
// down to 0 as the Variation slider rises, so "Vi lyfter fram rätter ni inte lagat förut"
// means the novelty penalty is genuinely removed rather than merely reduced. At
// variation 100 the familiarity term drops out entirely and repeat-avoidance becomes the
// novelty signal, which is the honest reading of that hint text.
//
// `WEIGHT_ON` in web/src/refinement.ts hardcodes the binary chips' one active notch (100,
// weight 3, "beats the largest possible familiarity gap") — not imported, because that
// module's type-only imports pull in this file's Node-only dependencies through tsc -b's
// type graph, which web/'s browser tsconfig cannot resolve. Re-derive that literal by
// hand if this value or MAX_AXIS_RANKING_WEIGHT changes.
const NEUTRAL_FAMILIARITY_STEP_WEIGHT = 1.5;

// Penalty applied to a template tagged `vegetarian` or `vegan` when the household
// has declared neither flag. One familiarity step at neutral (not a filter, and not the
// full seasonality-beating weight of two steps): an omnivore household eats meat most
// days but not every day, so a vegetarian dish should have to be otherwise better —
// cheaper, more in season, more familiar — to win, not be excluded outright. A household
// that has declared `vegetarian` or `vegan` gets no penalty at all.
//
// Pinned to the neutral constant rather than tracking `weights.familiarity`, which since
// #157 is variable. It used to be written as `= FAMILIARITY_STEP_WEIGHT`, and letting that
// alias survive the change would have made the Variation slider quietly rewrite how much
// an omnivore household prefers meat — two unrelated preferences moving on one control.
// "How adventurous a dish is" and "how often we eat vegetarian" are different questions;
// only the first one has a slider.
const OMNIVORE_PREFERENCE_WEIGHT = 1.5;

/**
 * The one and only translation from what a household expressed (slider notches, 0–100)
 * into what the score arithmetic uses (points per enum step). #157.
 *
 * Every axis's zero is defined to be its pre-#157 constant, which is what makes the
 * migration's defaults backward compatible by construction rather than by luck:
 *
 *  * `price: 0` → 0, the old `DEFAULT_WEIGHTS.cost`
 *  * `time: 0` → 0, the old `DEFAULT_WEIGHTS.time`
 *  * `variation: 0` → 1.5, the old `FAMILIARITY_STEP_WEIGHT`
 *
 * so `toRankingWeights(NEUTRAL_PREFERENCE_WEIGHTS)` produces exactly the constants this
 * module scored with before any of this existed. A household that never touches a
 * slider gets the same order over the whole template library, byte for byte.
 *
 * Price, time and simplicity rise linearly to `MAX_AXIS_RANKING_WEIGHT`; variation
 * *falls* linearly to zero, because a high Variation preference means less novelty
 * penalty, not more. That inversion is the reason this lives in one function: it is
 * the kind of sign error that would be invisible at a second call site.
 *
 * `simplicity` has been live since #153: #151 curated `effort_level` per template, so
 * this axis now derives a real term exactly like `price` and `time` do — a household
 * that has never touched the Enkelhet slider or tapped "Enklare" still scores at 0,
 * unchanged from before either issue landed.
 */
export function toRankingWeights(preference: PreferenceWeights): RankingWeights {
  const scale = MAX_AXIS_RANKING_WEIGHT / PREFERENCE_WEIGHT_MAX;

  return {
    price: preference.price * scale,
    time: preference.time * scale,
    familiarity:
      NEUTRAL_FAMILIARITY_STEP_WEIGHT * (1 - preference.variation / PREFERENCE_WEIGHT_MAX),
    simplicity: preference.simplicity * scale,
  };
}

/**
 * The engine weights for a household that has expressed nothing — the pre-#157
 * constants, reachable without restating them at a call site.
 */
export const NEUTRAL_RANKING_WEIGHTS: RankingWeights = toRankingWeights(
  NEUTRAL_PREFERENCE_WEIGHTS,
);

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
//  * Above 4.75 — the entire score spread available at `NEUTRAL_PREFERENCE_WEIGHTS`
//    (src/schema/preferenceWeights.ts, all axes at 0), which is two familiarity steps
//    (2 * 1.5 = 3.0) plus the omnivore preference (1.5) plus a full seasonality swing
//    (0.25). Anything above that total guarantees a dish cooked *tonight* ranks below
//    EVERY uncooked candidate for a household that has expressed nothing — which is the
//    bug this exists to fix (open the app three evenings running, get the same dish
//    three times). Below 4.75 it would merely be a nudge, and an adventurous
//    vegetarian dish could still lose to the meal cooked yesterday.
//
//    Re-checked for #157: the neutral spread is unchanged, because `variation: 0` maps
//    to exactly NEUTRAL_FAMILIARITY_STEP_WEIGHT. Raising Variation only *shrinks* this
//    spread (at variation 100 the familiarity term is 0 and the total is 1.75), so the
//    bound gets slacker as the slider rises, never tighter. This one does not need
//    re-picking per slider position.
//  * Below 6.0 — a single axis pushed all the way to 100 (weight
//    MAX_AXIS_RANKING_WEIGHT = 3) across a two-step cost-tier or prep-band gap. Staying
//    under it keeps repeat-avoidance beatable by the strongest preference a household
//    can actually express, the same yield-to-a-real-preference property
//    SEASONALITY_WEIGHT and NEUTRAL_FAMILIARITY_STEP_WEIGHT are both calibrated for: a
//    household that drags Pris to the top and means it can still be shown last night's
//    cheap dish over an expensive new one.
//
// If NEUTRAL_FAMILIARITY_STEP_WEIGHT, OMNIVORE_PREFERENCE_WEIGHT, SEASONALITY_WEIGHT or
// MAX_AXIS_RANKING_WEIGHT change, re-derive both bounds and re-pick this value inside the
// new band rather than leaving it calibrated to stale numbers.
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
/**
 * The `EngineData` slice pantry coverage needs, mirroring `SeasonalityData` above:
 * the substitution groups, and nothing else. Coverage stopped being answerable from
 * ids alone in #219 — a household that marked "ris" has covered a slot calling for
 * `jasminris` — so the rule needs the groups in hand.
 */
export type PantryCoverageData = Pick<EngineData, "substitutionGroupsByMemberIngredientId">;

/** One slot of a dish, paired with the pantry item the household actually marked. */
export interface PantryCoverage {
  /**
   * What the dish puts in the pan: the substitute where the filtering slice rescued
   * the slot, otherwise the template's own ingredient. The shopping list and the
   * ingredient rows key on this one, because it is the row a household reads.
   */
  ingredientId: string;
  /**
   * The pantry item covering it — equal to `ingredientId` unless a substitution group
   * bridged the two. The explanation line names *this* one: a household that marked
   * "ris" must not be told the dish was picked because they have jasminris, which
   * they never said.
   */
  pantryIngredientId: string;
}

/**
 * The pantry item covering `ingredientId` in a slot of `role`, or `undefined` when
 * the household has nothing that works there.
 *
 * Group membership is filtered by the slot's role exactly as `substituteCandidateIds`
 * (src/engine/candidates.ts) filters it, and for the same reason: "the household has
 * something that works in this slot" and "this slot could be swapped" are one
 * question. Without the filter the `aromatic` group `kokosmjolk-och-gradde` would
 * cover a `dairy` slot on the strength of a member name it happens to share.
 *
 * Never a safety decision. An allergic household's unsafe dishes left the candidate
 * set long before coverage is asked, so nothing here filters again — this only ever
 * decides ranking and display.
 */
function pantryItemCovering(
  data: PantryCoverageData,
  ingredientId: string,
  role: IngredientSlotRole,
  pantry: ReadonlySet<string>,
): string | undefined {
  if (pantry.has(ingredientId)) return ingredientId;

  // Data-file order throughout, so the answer is identical on every machine when more
  // than one marked item could cover the same slot.
  for (const group of data.substitutionGroupsByMemberIngredientId.get(ingredientId) ?? []) {
    if (group.role !== role) continue;
    for (const memberId of group.member_ingredient_ids) {
      if (memberId !== ingredientId && pantry.has(memberId)) return memberId;
    }
  }

  return undefined;
}

/**
 * Which of the household's on-hand ingredients this dish actually uses — resolved
 * through substitutions, so it is the ingredient the household would really put in
 * the pan and not the one the template happens to name, and through substitution
 * groups, so marking "ris" covers the eleven dishes whose slot says `jasminris`
 * (#219).
 *
 * The one definition of "pantry coverage" in the product. `orderByPantryCoverage`
 * (src/engine/directions.ts) orders by `distinctPantryItemCount` of it and
 * `explainSuggestion` names its members, so the dish that gets promoted for having
 * pasta at home is the same dish that says so on the card — there is no second rule
 * that could disagree.
 *
 * One entry per covered ingredient, not per slot: a dish using the same ingredient in
 * two slots covers it once. Two *different* ingredients covered by one pantry item
 * stay two entries, because both rows have to render as "har hemma" — the ranking
 * question ("how much of the pantry did this dish use") is `distinctPantryItemCount`,
 * which collapses them back to one.
 */
export function coveredPantryIngredients(
  data: PantryCoverageData,
  candidate: CandidateTemplate,
  pantry: ReadonlySet<string>,
): PantryCoverage[] {
  const seen = new Set<string>();
  const covered: PantryCoverage[] = [];

  effectiveIngredientIds(candidate).forEach((ingredientId, index) => {
    if (seen.has(ingredientId)) return;

    const role = candidate.template.ingredient_slots[index]?.role;
    if (role === undefined) return;

    const pantryIngredientId = pantryItemCovering(data, ingredientId, role, pantry);
    if (pantryIngredientId === undefined) return;

    seen.add(ingredientId);
    covered.push({ ingredientId, pantryIngredientId });
  });

  return covered;
}

/**
 * How many of the household's pantry items a dish actually used — the ranking
 * quantity, and the reason coverage is not simply counted by `length`: a dish using
 * both matlagningsgrädde and vispgrädde must not out-rank one using grädde and
 * potatis on the strength of a single tap.
 */
export function distinctPantryItemCount(coverage: readonly PantryCoverage[]): number {
  return new Set(coverage.map((entry) => entry.pantryIngredientId)).size;
}

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
  simplicityPenalty: number;
}

function scoreBreakdown(
  data: SeasonalityData,
  candidate: CandidateTemplate,
  weights: RankingWeights,
  month: number,
  householdDietaryFlags: readonly DietaryFlag[],
  recency?: RecencyContext,
): ScoreBreakdown {
  const costPenalty = costTierIndex(candidate.template.cost_tier) * weights.price;
  const timePenalty = prepTimeIndex(candidate.template.prep_time_band) * weights.time;
  const seasonalityBonus = inSeasonFraction(data, candidate, month) * SEASONALITY_WEIGHT;
  const familiarityPenalty =
    familiarityIndex(candidate.template.familiarity) * weights.familiarity;

  const householdIsVegetarianOrVegan =
    householdDietaryFlags.includes("vegetarian") || householdDietaryFlags.includes("vegan");
  const templateIsVegetarianOrVegan =
    candidate.template.dietary_tags.includes("vegetarian") ||
    candidate.template.dietary_tags.includes("vegan");
  const omnivorePenalty =
    templateIsVegetarianOrVegan && !householdIsVegetarianOrVegan ? OMNIVORE_PREFERENCE_WEIGHT : 0;

  const repeatPenalty = recency ? recencyPenalty(candidate.template.id, recency) : 0;

  const simplicityPenalty = effortLevelIndex(candidate.template.effort_level) * weights.simplicity;

  return {
    costPenalty,
    timePenalty,
    seasonalityBonus,
    familiarityPenalty,
    omnivorePenalty,
    repeatPenalty,
    simplicityPenalty,
  };
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
  return (
    b.costPenalty +
    b.timePenalty -
    b.seasonalityBonus +
    b.familiarityPenalty +
    b.omnivorePenalty +
    b.repeatPenalty +
    b.simplicityPenalty
  );
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
  | "pantry_match"
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
 * positive gaps out of every term the score has, named or not (familiarity, the
 * omnivore preference and simplicity have no user-facing phrasing yet — see
 * requirement 2, #122).
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
    { code: undefined, diff: runnerUpTerms.simplicityPenalty - pickedTerms.simplicityPenalty },
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
  // Widened past `SeasonalityData` in #219: the `pantry_match` reason below is
  // derived through `coveredPantryIngredients`, which needs the substitution groups.
  data: SeasonalityData & PantryCoverageData,
  ranked: readonly RankedCandidate[],
  excludedTemplateIds: ReadonlySet<string>,
  picked: RankedCandidate,
  previousTemplate: RecipeTemplate | undefined,
  weights: RankingWeights,
  month: number,
  householdDietaryFlags: readonly DietaryFlag[] = [],
  recency?: RecencyContext,
  /**
   * The household's on-hand ingredients for this request, when Tonight's pantry row
   * was used (#152). `ranked` is then expected to be the pantry-ordered list
   * `orderByPantryCoverage` produced — the same list the caller passed to
   * `pickNextSuggestion` — which is what makes `pantryDecidedThisPick` below decidable
   * from the list alone.
   */
  pantryIngredientIds: readonly string[] = [],
): readonly SuggestionReasonCode[] {
  const reasons: SuggestionReasonCode[] = [];

  const remaining = ranked.filter((candidate) => !excludedTemplateIds.has(candidate.template.id));
  const topScored = remaining[0];

  // Pantry coverage first, before variety and before any score term: when it fired it
  // is *the* thing that moved this dish to the front, and it is the only reason the
  // household can check against something they told the app one tap ago. A card that
  // silently reorders after a pantry tap teaches that the chips do nothing.
  //
  // "Fired" is exact rather than heuristic. The list is ordered by coverage first and
  // score second, so if `picked` heads it while some other candidate scores higher,
  // the only thing that can have demoted that candidate is a lower coverage bucket.
  // No coverage, or nothing outscoring the pick, means coverage changed no decision
  // and saying otherwise would credit a tap that did nothing.
  const covered =
    pantryIngredientIds.length > 0
      ? coveredPantryIngredients(data, picked, new Set(pantryIngredientIds))
      : [];
  const pantryDecidedThisPick =
    covered.length > 0 &&
    topScored?.template.id === picked.template.id &&
    remaining.some((candidate) => candidate.score > picked.score);

  if (pantryDecidedThisPick) reasons.push("pantry_match");

  const variety = varietyReason(picked, previousTemplate);
  if (variety && reasons.length < MAX_SUGGESTION_REASONS) reasons.push(variety);

  // `pickNextSuggestion`'s protein/cuisine diversity rule can hand back a candidate
  // that is *not* the best-scoring one remaining — that is the whole point of the
  // rule. When it does, the score did not decide `picked` over `topScored`; variety
  // did. Crediting a score term in that case (e.g. "cheaper" because `picked` happens
  // to have a lower cost tier than the candidate the score preferred) would be true
  // about the two dishes in isolation but false about what drove the decision —
  // exactly what requirement 5 forbids. Score-term reasons only make sense to compute
  // at all when `picked` *is* the plain score winner among what remains.
  //
  // Pantry coverage disqualifies score terms for the same reason variety does: when
  // the pick was promoted out of a bucket, `runnerUp` sits in a *lower* coverage
  // bucket, so any cost or time gap between the two is a fact about the pair and not
  // what drove the decision. The card says the one true thing and stops.
  const scoreDecidedThisPick =
    !pantryDecidedThisPick && topScored !== undefined && topScored.template.id === picked.template.id;

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
