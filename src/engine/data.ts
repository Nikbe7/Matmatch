import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { IngredientSchema, type Ingredient } from "../schema/ingredient.js";
import { RecipeTemplateSchema, type RecipeTemplate } from "../schema/recipeTemplate.js";
import { SubstitutionGroupSchema, type SubstitutionGroup } from "../schema/substitution.js";
import { VarietyFamilySchema, type VarietyFamily } from "../schema/varietyFamily.js";

// Loads the four curated data files the engine reads into plain in-memory indexes.
// No database, no ORM, no caching layer: the whole dataset is ~600 small records, and
// the engine is a set of pure functions over the structures returned here.
//
// `data/ingredient-allergens.json` is deliberately not among them (#224). The file
// still exists and `npm run validate` still checks it — 206 hand-verified rows are
// real work and are kept as a record — but nothing in the product reads it any more,
// and loading it here would put an allergen map back within reach of code that has no
// business consulting one. See DECISION_LOG 2026-08-25.

export interface EngineData {
  readonly ingredientsById: ReadonlyMap<string, Ingredient>;
  readonly templates: readonly RecipeTemplate[];
  readonly substitutionGroupsById: ReadonlyMap<string, SubstitutionGroup>;
  // Derived lookup, per §5.5: candidate swaps for a slot are the members of any
  // group whose role matches the slot's role and whose members include the slot's
  // ingredient. The reverse index is built here at load time rather than stored
  // in the data file, which §5.5 explicitly rules out.
  readonly substitutionGroupsByMemberIngredientId: ReadonlyMap<string, readonly SubstitutionGroup[]>;
  /**
   * The variety families, keyed by the `variety_of` value their members carry (#223).
   * Loaded because the family now owns curated text — the per-family note shown when
   * pantry coverage bridged two varieties — and because `validate` makes every
   * `variety_of` resolve here, so a key with no family is a data fault rather than a
   * lookup that quietly returns nothing.
   */
  readonly varietyFamiliesById: ReadonlyMap<string, VarietyFamily>;
  // Deliberately *not* here: a reverse index over `Ingredient.variety_of` (#221).
  // The issue sketched one, and it turned out to have no reader once the role filter
  // stayed in coverage: both consumers (#219 pantry coverage, #220 grid dedup) walk
  // the substitution groups and ask "is this member a variety of that one", which is
  // an equality test between two fields already in `ingredientsById` — see
  // `isSameVariety` (src/engine/catalog.ts). A class-keyed index would answer a
  // question nothing asks. `npm run validate` builds one of its own, for the single
  // check that does need it (a class of one).
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

  const [ingredients, templates, substitutionGroups, varietyFamilies] = await Promise.all([
    readRecords(`${dir}ingredients.json`, IngredientSchema),
    readRecords(`${dir}recipe-templates.json`, RecipeTemplateSchema),
    readRecords(`${dir}substitutions.json`, SubstitutionGroupSchema),
    readRecords(`${dir}variety-families.json`, VarietyFamilySchema),
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
    templates: Object.freeze(templates),
    substitutionGroupsById: indexById(substitutionGroups),
    substitutionGroupsByMemberIngredientId: groupsByMember,
    varietyFamiliesById: indexById(varietyFamilies),
  });
}
