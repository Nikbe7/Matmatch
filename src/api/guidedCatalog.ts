import type { CandidateTemplate } from "../engine/candidates.js";
import type { EngineData } from "../engine/data.js";
import type { Direction } from "../engine/directions.js";
import { effectiveIngredientIds } from "../engine/ranking.js";
import type { Allergy } from "../schema/allergyDietary.js";
import type { HouseholdMember } from "../schema/household.js";
import type { IngredientCategory } from "../schema/ingredient.js";
import { HttpError } from "./httpError.js";
import { buildTonightIngredients, type TonightIngredientView } from "./tonightIngredients.js";

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
 * keeps the grid from offering a fish-allergic household a tap target ("lax") whose
 * only possible outcome is the §9 empty state. It is not a safety mechanism — the
 * engine would never serve that dish either way — it is the difference between a
 * grid of real choices and a grid with traps in it.
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

function buildOptions(
  data: EngineData,
  candidates: readonly CandidateTemplate[],
  categories: readonly IngredientCategory[],
  limit: number,
): IngredientOption[] {
  const frequency = candidateFrequency(candidates);

  return [...frequency.entries()]
    .flatMap(([ingredientId, count]) => {
      const ingredient = data.ingredientsById.get(ingredientId);
      if (!ingredient || !categories.includes(ingredient.category)) return [];
      return [{ ingredient, count }];
    })
    // Ties break on id, never on catalog order: the grid must be identical on every
    // request and every machine, or two households comparing screens see different
    // apps for no reason.
    .sort((a, b) => b.count - a.count || (a.ingredient.id < b.ingredient.id ? -1 : 1))
    .slice(0, limit)
    .map(({ ingredient }) => ({ id: ingredient.id, name: ingredient.name }));
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

export interface ExcludedIngredientOption extends IngredientOption {
  /** Which of the household's own allergies excludes this ingredient. */
  allergies: Allergy[];
}

/**
 * Protein-category catalog ingredients that a fish- or nut-allergic household
 * cannot eat, for the step-2 filter's "why nothing matched" explanation
 * (requirement 4 of the type-to-filter issue). Read-only display data — it must
 * never widen what a household can actually select, so the filter itself keeps
 * matching against `buildMainIngredientOptions`'s safe set and only consults this
 * list to explain a miss.
 *
 * Limited to `verified` allergen rows on purpose. An unverified or missing row is
 * treated as containing every allergen for filtering (§5.4's fail-safe rule in
 * allergens.ts), but that is a "we don't know" default, not a fact about the
 * ingredient — naming it as the cause here would assert something we don't
 * actually know. Every protein in the catalog is verified today (see
 * data/ingredient-allergens.json), so this only ever narrows an already-empty set.
 */
export function buildExcludedMainIngredients(
  data: EngineData,
  allergies: readonly Allergy[],
): ExcludedIngredientOption[] {
  if (allergies.length === 0) return [];

  const excluded: ExcludedIngredientOption[] = [];
  for (const ingredient of data.ingredientsById.values()) {
    if (ingredient.category !== "protein") continue;

    const mapping = data.allergenMappingByIngredientId.get(ingredient.id);
    if (!mapping || mapping.verification_status !== "verified") continue;

    const causes = allergies.filter((allergy) => mapping.allergens.includes(allergy));
    if (causes.length === 0) continue;

    excluded.push({ id: ingredient.id, name: ingredient.name, allergies: causes });
  }

  return excluded.sort((a, b) => (a.id < b.id ? -1 : 1));
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
  householdMembers: readonly HouseholdMember[],
): GuidedIngredientView[] {
  const covered = new Set(direction.coveredPantryIngredientIds);
  const substituteBySlotIndex = new Map(
    direction.substitutions.map((substitution) => [
      substitution.slot_index,
      substitution.substitute_ingredient_id,
    ]),
  );

  return buildTonightIngredients(data, direction, householdMembers).map((view, index) => {
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
  // The summary line only ever reads a view's `name`, so no household is passed
  // through here — allergen marking is irrelevant to a sentence and this stays a
  // pure function of the direction, not of who owns the household.
  const views = buildTonightIngredients(data, direction, []);

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
