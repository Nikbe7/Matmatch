import type { Cuisine } from "../schema/recipeTemplate.js";
import {
  coveredPantryIngredients,
  distinctPantryItemCount,
  effectiveIngredientIds,
  type PantryCoverage,
  type PantryCoverageData,
  type RankedCandidate,
} from "./ranking.js";

// Third slice of the Meal Engine: pick the three direction cards the guided
// quick-select flow shows (UX_FLOW §5 step 4). Deterministic, pure, no I/O, no AI.
//
// This module deliberately does NOT score. `rankCandidates` stays the single source
// of ordering truth for the whole product — Tonight and the guided flow must never
// disagree about what is safe or what ranks higher — and everything here is
// *selection on top of that order*, exactly the way `pickNextSuggestion` already
// applies its protein/cuisine diversity rule without touching a score. The guided
// flow gets a different answer than Tonight only because the household handed it
// extra input (a main ingredient, a pantry, an intent) that Tonight never asked for.

/** How many cards UX_FLOW §5 step 4 shows. Three, "not chat text". */
export const DIRECTION_COUNT = 3;

/**
 * How the main-ingredient step (§5 step 2) constrains the direction set.
 *
 * `"any"` exists only for the loosen-constraints empty state (§9): when a chosen
 * ingredient leaves nothing, dropping the constraint entirely is the way out that
 * isn't a dead end. It is never how the flow starts.
 */
export type MainIngredientChoice = { kind: "ingredient"; ingredientId: string } | { kind: "any" };

export interface DirectionSelection {
  main: MainIngredientChoice;
  /**
   * Session-scoped pantry input (§5 step 3). Ephemeral by decision, not by
   * omission: it arrives per request, is read here, and is never written anywhere.
   * Empty means the household skipped the step, which is not the same as "has
   * nothing" — either way it simply stops being an ordering signal.
   */
  pantryIngredientIds?: readonly string[];
  /**
   * The "Proteinrikt" intent chip. A *preference* over the existing rank order, not
   * a filter and not a score term: `high_protein_preference` is a soft dietary flag
   * that `selectCandidateTemplates` deliberately refuses to hard-filter on (it would
   * cut the safe set to a handful of templates), and `scoreCandidate` has no term
   * for it. Expressing it here keeps both of those decisions intact while still
   * making the chip do something real.
   */
  preferHighProtein?: boolean;
  count?: number;
}

export interface Direction extends RankedCandidate {
  /**
   * Which of the household's pantry ingredients this dish actually uses — the
   * "✓ ris, ✓ grädde" half of §5 step 5, and what seeds the shopping list's
   * "Har hemma" section. Ids, in slot order, never names: naming is display work
   * that belongs to the API layer.
   *
   * Pairs since #219, not bare ids: a slot and the pantry item covering it can be
   * different ingredients now that substitution groups bridge them, and the two
   * consumers want different halves — the rows mark `ingredientId`, the explanation
   * line names `pantryIngredientId`.
   */
  pantryCoverage: readonly PantryCoverage[];
}

/**
 * The ordering key applied on top of the ranked order. Lower is better, and both
 * components are *bucket* keys — within a bucket the shared rank order decides,
 * untouched.
 *
 * The intent chip is the outer key because it is the one thing the household
 * explicitly asked for; pantry coverage is the inner key because it is supporting
 * input. For "Använd det jag har" — the intent whose entire lever *is* the pantry —
 * `preferHighProtein` is false, so coverage becomes the effective outer key and the
 * chip behaves the way its label promises.
 */
interface BucketKey {
  intentRank: number;
  coverage: number;
}

function sameBucket(a: BucketKey, b: BucketKey): boolean {
  return a.intentRank === b.intentRank && a.coverage === b.coverage;
}

interface Scored {
  direction: Direction;
  key: BucketKey;
}

function matchesMain(candidate: RankedCandidate, main: MainIngredientChoice): boolean {
  if (main.kind === "any") return true;
  return effectiveIngredientIds(candidate).includes(main.ingredientId);
}

/**
 * Every candidate the main-ingredient step allows, best-first, annotated with the
 * pantry ingredients it covers.
 *
 * Split out from `pickDirections` because the empty-state decision (§9) needs to
 * distinguish "nothing survives the constraints" from "fewer than three survive" —
 * three cards is a target, not a guarantee, and a constrained household legitimately
 * has one or two.
 */
export function eligibleDirections(
  data: PantryCoverageData,
  ranked: readonly RankedCandidate[],
  selection: DirectionSelection,
): Direction[] {
  const pantry = new Set(selection.pantryIngredientIds ?? []);

  return ranked.filter((candidate) => matchesMain(candidate, selection.main)).map((candidate) => ({
    ...candidate,
    // The shared definition (src/engine/ranking.ts), not a local one: the card that
    // says "du har pasta hemma" must be the card coverage actually promoted.
    pantryCoverage: coveredPantryIngredients(data, candidate, pantry),
  }));
}

function bucketKey(direction: Direction, preferHighProtein: boolean): BucketKey {
  const highProtein = direction.template.dietary_tags.includes("high_protein_preference");
  return {
    intentRank: preferHighProtein && highProtein ? 0 : 1,
    coverage: -distinctPantryItemCount(direction.pantryCoverage),
  };
}

/**
 * The ranked list re-ordered so dishes covering more of the household's pantry come
 * first, and nothing else changes: within one coverage bucket the candidates keep the
 * exact order `rankCandidates` gave them.
 *
 * Extracted from `pickDirections` (which now calls it) so Tonight's pantry row (#152)
 * and the guided flow's pantry step order dishes through the *same* code rather than
 * two implementations that agree today. A second implementation would be a second
 * answer to "does the household get credit for having pasta", and the two would
 * diverge the first time either was touched.
 *
 * Returns `Direction`s, not bare candidates: the caller needs `pantryCoverage` to
 * explain the pick (`pantry_match`, #152), and re-deriving coverage downstream would
 * be the same duplication one layer down.
 *
 * An empty pantry is the identity function — the household skipped the step, so
 * coverage is 0 everywhere and the stable sort leaves the ranked order untouched.
 */
export function orderByPantryCoverage(
  data: PantryCoverageData,
  ranked: readonly RankedCandidate[],
  pantryIngredientIds: readonly string[],
): Direction[] {
  const eligible = eligibleDirections(data, ranked, { main: { kind: "any" }, pantryIngredientIds });

  // Stable by specification (ES2019+): equal coverage must preserve the ranked order.
  return [...eligible].sort(
    (a, b) => distinctPantryItemCount(b.pantryCoverage) - distinctPantryItemCount(a.pantryCoverage),
  );
}

/**
 * The direction cards, best-first: at most `count`, fewer when the household's
 * constraints leave fewer, and empty when nothing survives at all.
 *
 * Two rules, in this order:
 *
 *  1. Bucket by intent preference then pantry coverage, stably — inside a bucket the
 *     candidates keep the exact order `rankCandidates` gave them.
 *  2. Within the *leading bucket only*, prefer a cuisine not already on screen. Three
 *     cards that are the same dish three ways is not a set of directions (UX_FLOW §5
 *     step 4 illustrates it with a pasta, a stew and a fried rice), and this is the
 *     same "prefer, else fall back" idiom `pickNextSuggestion` uses. Restricting it to
 *     the leading bucket is what stops variety from ever trading away a real pantry
 *     match: a dish using two things the household already has is never dropped for a
 *     more exotic one using none.
 */
export function pickDirections(
  data: PantryCoverageData,
  ranked: readonly RankedCandidate[],
  selection: DirectionSelection,
): Direction[] {
  const count = selection.count ?? DIRECTION_COUNT;
  const preferHighProtein = selection.preferHighProtein ?? false;

  // Coverage first, through the shared ordering (#152), then the intent key on top.
  // Two stable passes rather than one composite comparator: sorting stably by the
  // inner key and then by the outer one gives exactly the (intentRank, coverage)
  // order the `BucketKey` describes, and it keeps pantry coverage computed in one
  // place for both this flow and Tonight.
  const byCoverage = orderByPantryCoverage(
    data,
    eligibleDirections(data, ranked, selection),
    selection.pantryIngredientIds ?? [],
  );

  const scored: Scored[] = byCoverage.map((direction) => ({
    direction,
    key: bucketKey(direction, preferHighProtein),
  }));

  // Stable by specification (ES2019+), which is the point: equal keys must preserve
  // the order the pass above left them in rather than be reshuffled by the sort's
  // internals.
  const remaining = [...scored].sort((a, b) => a.key.intentRank - b.key.intentRank);

  const picked: Direction[] = [];
  const usedCuisines = new Set<Cuisine>();

  while (picked.length < count) {
    const leading = remaining[0];
    if (!leading) break;

    const fresh = remaining.find(
      (entry) =>
        sameBucket(entry.key, leading.key) && !usedCuisines.has(entry.direction.template.cuisine),
    );
    const chosen = fresh ?? leading;

    picked.push(chosen.direction);
    usedCuisines.add(chosen.direction.template.cuisine);
    remaining.splice(remaining.indexOf(chosen), 1);
  }

  return picked;
}

// Slot roles searched, in order, for the ingredient a dish is "about". Protein
// first because that is what a household names a dish by ("kyckling", "lax"), and
// because it is the axis the template library is authored along (`protein_group`,
// ARCHITECTURE.md §5.3).
const MAIN_INGREDIENT_ROLES = ["protein", "starch"] as const;

/**
 * "Föreslå åt mig" (§5 step 2): the main ingredient of the best-ranked candidate.
 *
 * Season, cost tier and cooking history are exactly what `rankCandidates` already
 * weighs, so the suggestion is that score read back rather than a second, parallel
 * notion of what is worth cooking. `undefined` when the household has no safe
 * candidates at all, or when the top one has no protein or starch slot — the caller
 * decides what that means.
 */
export function suggestMainIngredientId(ranked: readonly RankedCandidate[]): string | undefined {
  const best = ranked[0];
  if (!best) return undefined;

  const ingredientIds = effectiveIngredientIds(best);
  for (const role of MAIN_INGREDIENT_ROLES) {
    const index = best.template.ingredient_slots.findIndex((slot) => slot.role === role);
    if (index !== -1) return ingredientIds[index];
  }

  return undefined;
}
