import { AllergySchema, type Allergy } from "../schema/allergyDietary.js";
import type { EngineData } from "./data.js";

// Allergen resolution for a single ingredient — the highest-stakes function in the
// engine (ARCHITECTURE.md §4.3: allergy filtering is deterministic and never
// AI-dependent). Kept small and separately testable because ranking and the
// shopping list will reuse it.

// The fail-safe allergen set: when we do not have a trustworthy allergen row for an
// ingredient (row missing, or present but `unverified`), that ingredient is treated
// as containing EVERY allergen in the locked vocabulary — the exact rule in
// ARCHITECTURE.md §5.4 / DECISION_LOG 2026-07-31, which requires those two cases to
// behave identically to a row that positively contains the allergen.
//
// It is deliberately NOT derived from the household's own allergies, and the obvious
// "simplification" to that form must not be made. Deriving it from the household
// would make the unknown-data case indistinguishable from a *verified empty* row for
// any allergy the household does not have — i.e. it would silently reintroduce the
// permissive default this rule exists to prevent, and it would make the resolver's
// answer depend on who is asking rather than on what we know about the ingredient.
// Sourced from AllergySchema so a ninth vocabulary value can never be quietly
// omitted here (adding one requires the full re-review pass described in §5.4).
const ALL_ALLERGENS: ReadonlySet<Allergy> = new Set(AllergySchema.options);

export type AllergenResolutionData = Pick<
  EngineData,
  "ingredientsById" | "allergenMappingByIngredientId"
>;

/**
 * The allergens an ingredient must be assumed to contain, applying the §5.4
 * fail-safe rule. Returns the full vocabulary for an unverified or missing row.
 */
export function effectiveAllergens(
  data: AllergenResolutionData,
  ingredientId: string,
): ReadonlySet<Allergy> {
  const mapping = data.allergenMappingByIngredientId.get(ingredientId);
  if (!mapping || mapping.verification_status !== "verified") return ALL_ALLERGENS;
  return new Set(mapping.allergens);
}

/**
 * Whether a household must avoid this ingredient.
 *
 * Two distinct fail-closed conditions:
 *  - The ingredient is not in the catalog at all → excluded for everyone,
 *    regardless of allergies. We cannot say what an unknown ingredient even is, so
 *    it never reaches a plate. This does not rely on the CLI validator's coverage
 *    check having been run — the engine fails closed on its own.
 *  - The ingredient's allergen row is missing or `unverified` → treated as
 *    containing every allergen (see ALL_ALLERGENS above), so it is excluded for any
 *    household with at least one allergy. A household with no allergies applies no
 *    allergen filter at all, which is why this case is allergy-relative while the
 *    unknown-ingredient case above is not.
 */
export function isIngredientExcluded(
  data: AllergenResolutionData,
  ingredientId: string,
  allergies: readonly Allergy[],
): boolean {
  if (!data.ingredientsById.has(ingredientId)) return true;
  if (allergies.length === 0) return false;

  const contains = effectiveAllergens(data, ingredientId);
  return allergies.some((allergy) => contains.has(allergy));
}
