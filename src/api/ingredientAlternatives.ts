import {
  classifyCostTier,
  roleSubstitutionPool,
  substituteCandidateIds,
} from "../engine/candidates.js";
import type { EngineData } from "../engine/data.js";
import { scaleSlotQuantity, type ScaledQuantity } from "../engine/quantities.js";
import type { Allergy } from "../schema/allergyDietary.js";
import type { HouseholdMember } from "../schema/household.js";
import type { CostTier } from "../schema/ingredient.js";
import type { IngredientSlot } from "../schema/recipeTemplate.js";
import { ingredientAllergenMarkings, membersByDeclaredAllergy, type IngredientAllergenMarking } from "./tonightIngredients.js";

// Display-shaping for #124's ingredient-swap popover — the counterpart to
// tonightIngredients.ts and guidedCatalog.ts: the engine deals in ingredient ids and
// cost-tier comparisons, this resolves Swedish names and the curated tier vocabulary.
// Nothing here filters or scores anything a household could be served — that already
// happened in src/engine/candidates.ts before a single id reaches this module.

export interface IngredientAlternativeView {
  ingredientId: string;
  name: string;
  // The curated tier only — never a kronor figure (CLAUDE.md non-negotiable). The
  // popover renders this through the same `costTierMeter`/`costTierLabel` dot meter
  // every other surface uses.
  costTier: CostTier;
  // The slot's own scaled quantity, identical across every alternative for this slot
  // (a swap changes what you buy, not how much — tonightIngredients.ts's comment on
  // `quantity` says the same for the accepted dish). Carried on each alternative
  // anyway so applying a swap is "replace the item with this view", with no special
  // case for "quantity doesn't actually change."
  quantity: ScaledQuantity;
  allergens: IngredientAllergenMarking[];
}

export interface IngredientAlternativesView {
  substitutable: boolean;
  /** Omitted rather than empty when no candidate qualifies (#124 requirement 1). */
  cheaper?: IngredientAlternativeView[];
  similar?: IngredientAlternativeView[];
  /**
   * The full role-valid catalog pool, allergy-gated, minus the current ingredient —
   * always present when `substitutable` is true, even as `[]`. The client filters it
   * locally by typed query (the #110 idiom), so this is fetched once per popover open
   * rather than once per keystroke.
   */
  searchPool?: IngredientAlternativeView[];
}

/**
 * Everything #124's popover needs for one slot: whether it accepts swaps at all, and
 * if so, the classified curated alternatives plus the wider search pool. `slot` and
 * `currentIngredientId` are always server-derived (the route re-reads the slot from
 * the template and validates the ingredient id against the catalog) — never trusted
 * as-is from the client beyond that validation.
 */
export function buildIngredientAlternatives(
  engineData: EngineData,
  slot: IngredientSlot,
  currentIngredientId: string,
  householdMembers: readonly HouseholdMember[],
  allergies: readonly Allergy[],
  portions: number,
): IngredientAlternativesView {
  if (!slot.substitutable) return { substitutable: false };

  const currentIngredient = engineData.ingredientsById.get(currentIngredientId);
  const membersByAllergy = membersByDeclaredAllergy(householdMembers);
  const quantity = scaleSlotQuantity(slot.quantity, portions);

  const toView = (ingredientId: string): IngredientAlternativeView | undefined => {
    const ingredient = engineData.ingredientsById.get(ingredientId);
    if (!ingredient) return undefined;
    return {
      ingredientId,
      name: ingredient.name,
      costTier: ingredient.default_cost_tier,
      quantity,
      allergens: ingredientAllergenMarkings(engineData, ingredientId, membersByAllergy),
    };
  };

  const narrowCandidateIds = substituteCandidateIds(engineData, slot.role, currentIngredientId, allergies);
  const { cheaper: cheaperIds, similar: similarIds } = currentIngredient
    ? classifyCostTier(engineData, narrowCandidateIds, currentIngredient.default_cost_tier)
    : { cheaper: [], similar: [] };

  const searchPoolIds = roleSubstitutionPool(engineData, slot.role, currentIngredientId, allergies);

  const view: IngredientAlternativesView = {
    substitutable: true,
    searchPool: searchPoolIds.map(toView).filter((item): item is IngredientAlternativeView => item !== undefined),
  };
  const cheaper = cheaperIds.map(toView).filter((item): item is IngredientAlternativeView => item !== undefined);
  const similar = similarIds.map(toView).filter((item): item is IngredientAlternativeView => item !== undefined);
  if (cheaper.length > 0) view.cheaper = cheaper;
  if (similar.length > 0) view.similar = similar;

  return view;
}
