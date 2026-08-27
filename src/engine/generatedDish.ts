import { COST_TIER_ORDER } from "../tools/validation.js";
import type { Allergy, DietaryFlag } from "../schema/allergyDietary.js";
import type { CostTier } from "../schema/ingredient.js";
import type { GeneratedDishOutput } from "../schema/generatedDish.js";
import { isIngredientUnknown } from "./catalog.js";
import type { EngineData } from "./data.js";

// Tier 2 deterministic core (issue #113): resolving a model's proposed dish against
// the curated catalog, and deciding whether the result may reach a given household.
// Nothing here calls the AI Orchestrator or does I/O — same purity contract as the
// rest of src/engine/.

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------
//
// Exact match only, in two normalized forms — never fuzzy/substring/Levenshtein
// matching. A fuzzy match that succeeds *wrongly* silently attaches a verified
// allergen row to the wrong ingredient (e.g. "mandel" vs "mandelmjölk", "ost" vs
// "getost") — a fail-*open* failure no test can reliably catch, because the test
// would have to predict which wrong pair the model proposes. Exact matching keeps
// the only possible failure mode "unresolved," which is fail-closed and handled by
// isGeneratedDishVisibleToHousehold below. Recall is the prompt's job (the model is
// given the full catalog as its allowed vocabulary, src/ai/dishPrompt.ts) — not the
// matcher's.

function normalizeIngredientName(raw: string): string {
  return raw.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}

const ASCII_FOLDS: Record<string, string> = { ö: "o", ä: "a", å: "a" };

/**
 * Ascii-folded, hyphenated form of a name — the same transform the curated catalog's
 * ids were authored under (src/schema/ingredient.ts's SlugIdSchema comment). Exists
 * as a fallback match for a model that reproduces a name without its diacritics
 * (e.g. "gul lok" for "gul lök"), which the plain normalized-name index above would
 * otherwise treat as a clean miss.
 */
function asciiSlug(raw: string): string {
  const normalized = normalizeIngredientName(raw);
  const folded = [...normalized].map((ch) => ASCII_FOLDS[ch] ?? ch).join("");
  return folded
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

const nameIndexCache = new WeakMap<EngineData["ingredientsById"], ReadonlyMap<string, string>>();

/** Normalized ingredient name -> ingredient id, built once per EngineData and cached. */
function ingredientNameIndex(data: EngineData): ReadonlyMap<string, string> {
  const cached = nameIndexCache.get(data.ingredientsById);
  if (cached) return cached;

  const index = new Map<string, string>();
  for (const ingredient of data.ingredientsById.values()) {
    index.set(normalizeIngredientName(ingredient.name), ingredient.id);
  }
  nameIndexCache.set(data.ingredientsById, index);
  return index;
}

/**
 * The catalog ingredient id a model-proposed name resolves to, or undefined when it
 * matches nothing. Deterministic and total — the only two paths are the normalized
 * name index and the ascii-slug id fallback; there is no third, looser path.
 */
export function resolveIngredientName(data: EngineData, proposedName: string): string | undefined {
  const byName = ingredientNameIndex(data).get(normalizeIngredientName(proposedName));
  if (byName) return byName;

  const slug = asciiSlug(proposedName);
  return data.ingredientsById.has(slug) ? slug : undefined;
}

export interface ResolvedIngredientSlot {
  role: GeneratedDishOutput["ingredients"][number]["role"];
  proposedName: string;
  /** undefined means unresolved: no catalog ingredient matched this name. */
  ingredientId: string | undefined;
}

export interface ResolvedGeneratedDish {
  output: GeneratedDishOutput;
  slots: readonly ResolvedIngredientSlot[];
  /** Distinct proposed names that resolved to nothing, in first-seen order. */
  unresolvedNames: readonly string[];
  hasUnverifiedContent: boolean;
  /**
   * Highest cost tier among resolved ingredients, or undefined when it cannot be
   * derived (any unresolved slot) — requirement: no cost figure is shown when it
   * cannot be derived from curated data. Never taken from the model.
   */
  costTier: CostTier | undefined;
  /** Only ever high_protein_preference — see the comment below. */
  dietaryTags: readonly DietaryFlag[];
}

function deriveCostTier(
  data: EngineData,
  slots: readonly ResolvedIngredientSlot[],
): CostTier | undefined {
  let highest: CostTier | undefined;
  for (const slot of slots) {
    if (!slot.ingredientId) return undefined;
    const ingredient = data.ingredientsById.get(slot.ingredientId);
    if (!ingredient) return undefined;
    if (!highest || COST_TIER_ORDER[ingredient.default_cost_tier] > COST_TIER_ORDER[highest]) {
      highest = ingredient.default_cost_tier;
    }
  }
  return highest;
}

/**
 * Resolves every proposed ingredient against the curated catalog and derives the
 * fields that must never come from the model (cost tier, high_protein_preference).
 *
 * dietaryTags can only ever contain "high_protein_preference" here, never
 * "vegetarian"/"vegan": those require a per-ingredient animal-origin fact the
 * catalog does not carry (data/ingredients.json has no such field), so there is
 * nothing to derive them from. A generated dish therefore always fails the existing
 * hard vegetarian/vegan filter (src/engine/candidates.ts's passesHardDietaryFilter)
 * — correct and fail-closed, not a bug in this slice. See issue #113's design notes
 * and the follow-up filed for a curated animal-origin flag.
 */
export function resolveGeneratedDish(data: EngineData, output: GeneratedDishOutput): ResolvedGeneratedDish {
  const slots: ResolvedIngredientSlot[] = output.ingredients.map((ingredient) => ({
    role: ingredient.role,
    proposedName: ingredient.name,
    ingredientId: resolveIngredientName(data, ingredient.name),
  }));

  const unresolvedNames = [...new Set(slots.filter((slot) => !slot.ingredientId).map((slot) => slot.proposedName))];
  const hasUnverifiedContent = unresolvedNames.length > 0;

  const hasStarchSlot = output.ingredients.some((ingredient) => ingredient.role === "starch");
  const dietaryTags: DietaryFlag[] = hasStarchSlot ? [] : ["high_protein_preference"];

  return {
    output,
    slots,
    unresolvedNames,
    hasUnverifiedContent,
    costTier: hasUnverifiedContent ? undefined : deriveCostTier(data, slots),
    dietaryTags,
  };
}

// ---------------------------------------------------------------------------
// Visibility gate
// ---------------------------------------------------------------------------

/**
 * Whether a resolved generated dish may be shown.
 *
 * Reduced to the catalog check by #224. The allergen half of this gate is gone with
 * the rest of allergy filtering; what remains is the one condition that was never
 * about allergies — a slot naming an ingredient the engine cannot identify has no
 * name, quantity or cost tier to render, so the dish is withheld rather than shown
 * with a hole in it.
 *
 * `hasUnverifiedContent` no longer withholds anything. It never did for a household
 * without declared allergies, which is now every household; the caller still marks
 * such a dish unverified for display.
 */
export function isGeneratedDishVisibleToHousehold(
  data: Pick<EngineData, "ingredientsById">,
  resolved: ResolvedGeneratedDish,
): boolean {
  return resolved.slots.every((slot) => !slot.ingredientId || !isIngredientUnknown(data, slot.ingredientId));
}
