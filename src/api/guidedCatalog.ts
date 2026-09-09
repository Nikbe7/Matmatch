import type { CandidateTemplate } from "../engine/candidates.js";
import { isSameVariety } from "../engine/catalog.js";
import type { EngineData } from "../engine/data.js";
import type { Direction } from "../engine/directions.js";
import { effectiveIngredientIds } from "../engine/ranking.js";
import type { IngredientCategory } from "../schema/ingredient.js";
import { HttpError } from "./httpError.js";
import { buildTonightIngredients, type TonightIngredientView } from "./tonightIngredients.js";
import { REFERENCE_PORTIONS } from "../engine/quantities.js";

// Display-shaping for the guided flow's routes, the counterpart to
// tonightIngredients.ts: the engine deals in ingredient ids, the screen needs
// Swedish names and a set of tapable options. Nothing here is Meal Engine logic and
// nothing here scores or filters anything a household could be served.

export interface IngredientOption {
  id: string;
  name: string;
}

/**
 * How many options each grid offers. Sized for a 360px screen at three columns —
 * four rows of proteins, six of pantry staples — and for the tap-first principle:
 * a grid long enough to need scrolling is a list, and a list is one step from the
 * search box UX_FLOW §5 explicitly rules out.
 */
export const MAIN_INGREDIENT_GRID_SIZE = 12;
export const PANTRY_GRID_SIZE = 18;

// The pantry is what a household has *in the cupboard*: staples, vegetables, dairy
// and aromatics. Proteins are excluded because they are step 2's question, and
// asking the same thing twice with different wording is exactly the kind of form
// UX_FLOW §1 says not to build. `condiment`, `fat_oil` and `fruit` are left out for
// a different reason: nobody plans a dinner around having mustard.
const PANTRY_CATEGORIES: readonly IngredientCategory[] = [
  "starch",
  "vegetable",
  "dairy",
  "spice_aromatic",
];

/**
 * How many of the household's safe dishes use each ingredient, counted once per
 * dish and resolved through substitutions — the ingredient the household would
 * actually eat, not the one the template names.
 *
 * "Common" is derived from the curated library rather than hand-picked: the
 * ingredients worth offering are the ones the most dishes can actually be built
 * from, so the grids follow the catalog instead of going stale beside it. Counted
 * over the *household's* candidate set rather than the whole library, which is what
 * keeps the grid from offering a vegetarian household a tap target ("kycklingfilé")
 * whose only possible outcome is the §9 empty state. It is not a filtering mechanism
 * — the engine would never serve that dish either way — it is the difference between
 * a grid of real choices and a grid with traps in it.
 */
function candidateFrequency(candidates: readonly CandidateTemplate[]): Map<string, number> {
  const frequency = new Map<string, number>();

  for (const candidate of candidates) {
    for (const ingredientId of new Set(effectiveIngredientIds(candidate))) {
      frequency.set(ingredientId, (frequency.get(ingredientId) ?? 0) + 1);
    }
  }

  return frequency;
}

/**
 * Whether `ingredientId` is interchangeable with something already on the grid, in
 * which case offering it is offering the same tap twice (#220).
 *
 * Greedy against the ids already taken, deliberately not a union-find over the group
 * graph: `creme-fraiche` belongs to both `gradde` and `syrade-mjolkprodukter`, so
 * transitive merging would put vispgrädde and filmjölk behind one square. Matching
 * only against what is already picked keeps every collapse one hop from a square the
 * household can actually see.
 *
 * Two ingredients collapse only when they are *varieties* of one product (#221), not
 * merely swappable for each other: "ris" and "jasminris" are one question the
 * household can only answer once, while gul lök and vitlök are two separate things to
 * have in the cupboard and deserve two squares. The same relation the engine's
 * coverage uses, so the grid can never offer a tap that coverage then ignores.
 *
 * No role filter, for the same reason `pantryItemCovering` in the engine has none: both
 * ask what a household has in the cupboard, which is a question about the ingredient and
 * not about any particular slot. Variety classes do span roles in the live catalog —
 * `hardost`, `mjolk` and `yoghurt` all appear in both `dairy` and `protein` slots — so a
 * role filter here would have shown two squares for one product depending on which
 * dishes the household happened to qualify for.
 */
function isInterchangeableWithPicked(
  data: EngineData,
  ingredientId: string,
  picked: ReadonlySet<string>,
): boolean {
  for (const group of data.substitutionGroupsByMemberIngredientId.get(ingredientId) ?? []) {
    for (const memberId of group.member_ingredient_ids) {
      if (memberId === ingredientId || !picked.has(memberId)) continue;
      if (isSameVariety(data, ingredientId, memberId)) return true;
    }
  }
  return false;
}

function buildOptions(
  data: EngineData,
  candidates: readonly CandidateTemplate[],
  categories: readonly IngredientCategory[],
  limit: number,
): IngredientOption[] {
  const frequency = candidateFrequency(candidates);

  const ordered = [...frequency.entries()]
    .flatMap(([ingredientId, count]) => {
      const ingredient = data.ingredientsById.get(ingredientId);
      if (!ingredient || !categories.includes(ingredient.category)) return [];
      return [{ ingredient, count }];
    })
    // Ties break on id, never on catalog order: the grid must be identical on every
    // request and every machine, or two households comparing screens see different
    // apps for no reason.
    .sort((a, b) => b.count - a.count || (a.ingredient.id < b.ingredient.id ? -1 : 1));

  // One square per substitution group (#220). Walked in frequency order and filled to
  // `limit` *after* the skips, so collapsing "ris"/"jasminris" into one square hands
  // the freed slot to the next staple down rather than shortening the grid. The
  // survivor keeps its own id and name — group ids are not a usable namespace here
  // (five of them collide with ingredient ids), so nothing downstream has to learn a
  // second kind of identifier.
  const picked = new Set<string>();
  const options: IngredientOption[] = [];

  for (const { ingredient } of ordered) {
    if (options.length >= limit) break;
    if (isInterchangeableWithPicked(data, ingredient.id, picked)) continue;
    picked.add(ingredient.id);
    options.push({ id: ingredient.id, name: ingredient.name });
  }

  return options;
}

/** The step-2 grid: the proteins the most of this household's dinners are built from. */
export function buildMainIngredientOptions(
  data: EngineData,
  candidates: readonly CandidateTemplate[],
): IngredientOption[] {
  return buildOptions(data, candidates, ["protein"], MAIN_INGREDIENT_GRID_SIZE);
}

/** The step-3 grid: the staples this household is most likely to already have. */
export function buildPantryIngredientOptions(
  data: EngineData,
  candidates: readonly CandidateTemplate[],
): IngredientOption[] {
  return buildOptions(data, candidates, PANTRY_CATEGORIES, PANTRY_GRID_SIZE);
}


export interface GuidedIngredientView extends TonightIngredientView {
  /**
   * Whether this ingredient is one the household said it already has. Drives the
   * "✓ ris, ✓ grädde" line on the card and seeds the shopping list's "Har hemma"
   * section — the split UX_FLOW §5 step 5 and §7 both ask for.
   */
  inPantry: boolean;
}

export function buildGuidedIngredients(
  data: EngineData,
  direction: Direction,
  portions: number,
): GuidedIngredientView[] {
  // The slot-side half of each pair (#219): these mark the *rows*, so they must name
  // what the dish uses. A household that marked "ris" gets the jasminris row ticked.
  const covered = new Set(direction.pantryCoverage.map((entry) => entry.ingredientId));
  const substituteBySlotIndex = new Map(
    direction.substitutions.map((substitution) => [
      substitution.slot_index,
      substitution.substitute_ingredient_id,
    ]),
  );

  return buildTonightIngredients(data, direction, portions, direction.pantryCoverage).map((view, index) => {
    const ingredientId =
      substituteBySlotIndex.get(index) ?? direction.template.ingredient_slots[index]?.ingredient_id;
    return { ...view, inPantry: ingredientId !== undefined && covered.has(ingredientId) };
  });
}

// Roles that describe what a dish *is*, in the order a Swedish home cook would name
// them: "kycklingfilé, jasminris och röd paprika". Aromatics and dairy are omitted —
// "gul lök" is in almost every dish and says nothing about which direction this is.
const SUMMARY_ROLES = ["protein", "starch", "vegetable"] as const;

/** "a, b och c" — Swedish list conjunction, which is not a comma. */
function joinSwedish(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} och ${parts[parts.length - 1]}`;
}

/**
 * The card's one-line description (UX_FLOW §5 step 4).
 *
 * Deterministic and derived, not authored and not generated: recipe templates store
 * structure rather than prose (CLAUDE.md), adding a `description` field is out of
 * scope for this slice, and an AI-written line is a Tier 1 concern that belongs to
 * the follow-up. So the line states what is actually in the dish — the one thing the
 * data can say truthfully — using the substituted ingredient wherever a slot was
 * rescued, so it never advertises something the household cannot eat.
 */
export function buildDirectionSummary(data: EngineData, direction: Direction): string {
  // The summary line only ever reads a view's `name`, so no real portion count is
  // passed through here — amounts are irrelevant to a sentence, and this stays a pure
  // function of the direction rather than of how many people are eating. The
  // reference count stands in precisely because its scaled amounts are the authored
  // ones and nothing reads them.
  const views = buildTonightIngredients(data, direction, REFERENCE_PORTIONS);

  const named: string[] = [];
  for (const role of SUMMARY_ROLES) {
    const view = views.find((candidate) => candidate.role === role);
    if (view) named.push(view.name);
  }

  // A dish with none of the three roles (a soup of vegetables tagged as aromatics,
  // say) still needs a line: fall back to the first slots in authored order rather
  // than rendering an empty string.
  const parts = named.length > 0 ? named : views.slice(0, 3).map((view) => view.name);

  return joinSwedish(parts);
}

// Bounded for the same reason `parseExcludeFromQuery` bounds `exclude`: a query
// parameter is client-supplied and must not be able to grow the work per request
// without limit. Comfortably above the grid the client can actually tap from.
const MAX_PANTRY_IDS = PANTRY_GRID_SIZE * 2;

/**
 * The pantry ingredient ids for one request (UX_FLOW §5 step 3).
 *
 * Session-scoped and ephemeral by decision (CLAUDE.md non-negotiable, ARCHITECTURE
 * §5's `SessionPantryInput` note): they arrive on the query string, are read once to
 * order the direction set, and are never written to the database, the household
 * profile, an analytics payload or anywhere else. There is deliberately no
 * repository module for them — persistence would be a reversal of that decision,
 * not a missing feature.
 *
 * Unknown ids are rejected rather than ignored: unlike a stale template id, which a
 * household legitimately holds after its constraints change, these come from a
 * closed catalog the client just fetched from `/api/guided/options`, so an
 * unrecognised one means client/server drift that should be loud.
 */
export function parsePantryFromQuery(data: EngineData, raw: unknown): string[] {
  if (raw === undefined) return [];
  if (typeof raw !== "string") {
    throw new HttpError(400, "invalid_pantry", "pantry must be a single comma-separated string");
  }
  if (raw.length === 0) return [];

  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .slice(0, MAX_PANTRY_IDS);

  for (const id of ids) {
    if (!data.ingredientsById.has(id)) {
      throw new HttpError(400, "invalid_pantry", `unknown ingredient id: ${id}`);
    }
  }

  return [...new Set(ids)];
}

/**
 * How the request answers step 2. Three forms, all explicit:
 *
 *  * an ingredient id — the household tapped one
 *  * `auto` — "Föreslå åt mig", and the engine reads the best-ranked candidate
 *  * `any` — no main-ingredient constraint at all, reachable only from the §9
 *    loosen-constraints empty state
 *
 * Required rather than optional: "the parameter is missing" is not a shade of
 * meaning this flow has, and letting it stand in for one of the three would make the
 * most consequential filter in the request the easiest thing to get wrong.
 */
export type MainParameter =
  | { kind: "ingredient"; ingredientId: string }
  | { kind: "auto" }
  | { kind: "any" };

export function parseMainFromQuery(data: EngineData, raw: unknown): MainParameter {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new HttpError(400, "invalid_main", "main must be an ingredient id, 'auto' or 'any'");
  }
  if (raw === "auto") return { kind: "auto" };
  if (raw === "any") return { kind: "any" };

  if (!data.ingredientsById.has(raw)) {
    throw new HttpError(400, "invalid_main", `unknown ingredient id: ${raw}`);
  }

  return { kind: "ingredient", ingredientId: raw };
}
