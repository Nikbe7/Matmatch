import type { Ingredient } from "../../schema/ingredient.js";
import type { IngredientAllergenMapping } from "../../schema/ingredientAllergenMapping.js";
import type { IngredientSlot, RecipeTemplate } from "../../schema/recipeTemplate.js";
import type { SubstitutionGroup } from "../../schema/substitution.js";
import type { EngineData } from "../data.js";

// In-memory EngineData for engine unit tests. Fail-safe cases (missing mapping row,
// `unverified` row, ingredient absent from the catalog) cannot be exercised against
// data/*.json — all 206 real rows are verified and covered — and must never be
// tested by editing real data, so they are constructed here instead.

export function makeIngredient(id: string, overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id,
    name: id,
    category: "vegetable",
    default_cost_tier: "budget",
    peak_months: [],
    available_year_round: true,
    seasonality_strength: "weak",
    ...overrides,
  };
}

/**
 * A slot with a stated quantity, for the many tests that care about filtering,
 * ranking or naming and not at all about amounts (#123).
 *
 * The quantity is required on the schema with no default, deliberately — so this
 * helper exists to keep that strictness from turning every unrelated test into a
 * place where an arbitrary number had to be invented. A test that *is* about amounts
 * passes its own via `quantity`.
 */
export function makeSlot(
  slot: Omit<IngredientSlot, "quantity"> & { quantity?: IngredientSlot["quantity"] },
): IngredientSlot {
  return { quantity: { kind: "amount", amount: 100, unit: "g" }, ...slot };
}

export function makeTemplate(id: string, overrides: Partial<RecipeTemplate> = {}): RecipeTemplate {
  return {
    id,
    name: id,
    blurb: `Testmall för ${id}.`,
    protein_group: "vegetarian_vegan",
    cuisine: "swedish_nordic",
    cost_tier: "budget",
    prep_time_band: "<20min",
    dietary_tags: [],
    meal_types: ["dinner"],
    familiarity: "everyday",
    // #151: arbitrary but valid, same discipline as the rest of this default —
    // tests that care about effort_level pass their own via `overrides`.
    effort_level: "moderate",
    ingredient_slots: [],
    ...overrides,
  };
}

export function makeEngineData(parts: {
  ingredients?: readonly Ingredient[];
  allergenMappings?: readonly IngredientAllergenMapping[];
  templates?: readonly RecipeTemplate[];
  substitutionGroups?: readonly SubstitutionGroup[];
}): EngineData {
  const ingredients = parts.ingredients ?? [];
  const substitutionGroups = parts.substitutionGroups ?? [];

  const groupsByMember = new Map<string, SubstitutionGroup[]>();
  for (const group of substitutionGroups) {
    for (const memberId of group.member_ingredient_ids) {
      const existing = groupsByMember.get(memberId);
      if (existing) existing.push(group);
      else groupsByMember.set(memberId, [group]);
    }
  }

  return {
    ingredientsById: new Map(ingredients.map((ingredient) => [ingredient.id, ingredient])),
    allergenMappingByIngredientId: new Map(
      (parts.allergenMappings ?? []).map((mapping) => [mapping.ingredient_id, mapping]),
    ),
    templates: parts.templates ?? [],
    substitutionGroupsById: new Map(substitutionGroups.map((group) => [group.id, group])),
    substitutionGroupsByMemberIngredientId: groupsByMember,
  };
}
