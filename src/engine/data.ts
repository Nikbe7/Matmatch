import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { IngredientSchema, type Ingredient } from "../schema/ingredient.js";
import {
  IngredientAllergenMappingSchema,
  type IngredientAllergenMapping,
} from "../schema/ingredientAllergenMapping.js";
import { RecipeTemplateSchema, type RecipeTemplate } from "../schema/recipeTemplate.js";
import { SubstitutionGroupSchema, type SubstitutionGroup } from "../schema/substitution.js";

// Loads the four curated data files into plain in-memory indexes. No database,
// no ORM, no caching layer: the whole dataset is ~600 small records, and the
// engine is a set of pure functions over the structures returned here.

export interface EngineData {
  readonly ingredientsById: ReadonlyMap<string, Ingredient>;
  readonly allergenMappingByIngredientId: ReadonlyMap<string, IngredientAllergenMapping>;
  readonly templates: readonly RecipeTemplate[];
  readonly substitutionGroupsById: ReadonlyMap<string, SubstitutionGroup>;
  // Derived lookup, per §5.5: candidate swaps for a slot are the members of any
  // group whose role matches the slot's role and whose members include the slot's
  // ingredient. The reverse index is built here at load time rather than stored
  // in the data file, which §5.5 explicitly rules out.
  readonly substitutionGroupsByMemberIngredientId: ReadonlyMap<string, readonly SubstitutionGroup[]>;
}

const DEFAULT_DATA_DIR = fileURLToPath(new URL("../../data/", import.meta.url));

async function readRecords<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  return z.array(schema).parse(raw);
}

function indexById<T extends { id: string }>(records: readonly T[]): ReadonlyMap<string, T> {
  return new Map(records.map((record) => [record.id, record]));
}

export async function loadEngineData(dataDir: string = DEFAULT_DATA_DIR): Promise<EngineData> {
  const dir = dataDir.endsWith("/") ? dataDir : `${dataDir}/`;

  const [ingredients, allergenMappings, templates, substitutionGroups] = await Promise.all([
    readRecords(`${dir}ingredients.json`, IngredientSchema),
    readRecords(`${dir}ingredient-allergens.json`, IngredientAllergenMappingSchema),
    readRecords(`${dir}recipe-templates.json`, RecipeTemplateSchema),
    readRecords(`${dir}substitutions.json`, SubstitutionGroupSchema),
  ]);

  const groupsByMember = new Map<string, SubstitutionGroup[]>();
  for (const group of substitutionGroups) {
    for (const memberId of group.member_ingredient_ids) {
      const existing = groupsByMember.get(memberId);
      if (existing) existing.push(group);
      else groupsByMember.set(memberId, [group]);
    }
  }

  return Object.freeze({
    ingredientsById: indexById(ingredients),
    allergenMappingByIngredientId: new Map(
      allergenMappings.map((mapping) => [mapping.ingredient_id, mapping]),
    ),
    templates: Object.freeze(templates),
    substitutionGroupsById: indexById(substitutionGroups),
    substitutionGroupsByMemberIngredientId: groupsByMember,
  });
}
