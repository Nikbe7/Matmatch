import type { z } from "zod";
import { IngredientSchema, type CostTier } from "../schema/ingredient.js";
import { RecipeTemplateSchema } from "../schema/recipeTemplate.js";
import { IngredientAllergenMappingSchema } from "../schema/ingredientAllergenMapping.js";
import { SubstitutionGroupSchema } from "../schema/substitution.js";

// DECISION_LOG.md 2026-07-31 — RecipeTemplate cost_tier and dietary_tags
// (high_protein_preference) are derived, not authored. This ordering is the
// single source of truth for "highest tier" comparisons below.
export const COST_TIER_ORDER: Record<CostTier, number> = {
  budget: 0,
  mid: 1,
  premium: 2,
};

export type RecordType = "ingredient" | "recipe-template" | "ingredient-allergen" | "substitution";

interface TypeConfig {
  schema: z.ZodType;
  // Ingredient ids this record references, for cross-file referential checks
  // against the ingredient catalog. Omitted for types that reference nothing.
  extractIngredientRefs?: (record: Record<string, unknown>) => string[];
  // Where this type's data lives by default, relative to the repo root, used
  // when `npm run validate` is invoked with no explicit --type groups. Plain
  // paths are checked for existence and skipped-with-a-note if absent; glob
  // patterns are expanded and simply contribute nothing if they match zero
  // files (no "missing" note — an unsplit catalog is not an error).
  defaultPaths: string[];
}

const TYPE_REGISTRY: Record<RecordType, TypeConfig> = {
  ingredient: {
    schema: IngredientSchema,
    defaultPaths: ["data/ingredients.json", "data/ingredients/*.json"],
  },
  "recipe-template": {
    schema: RecipeTemplateSchema,
    extractIngredientRefs: (record) =>
      Array.isArray(record.ingredient_slots)
        ? record.ingredient_slots
            .map((slot) => (slot as { ingredient_id?: unknown })?.ingredient_id)
            .filter((id): id is string => typeof id === "string")
        : [],
    defaultPaths: ["data/recipe-templates.json"],
  },
  // Still validated, deliberately, even though nothing in the product reads the file
  // any more (#224). The 206 hand-verified rows are kept as a record, and a record
  // that silently rots is worth less than no record: schema, duplicate ids and
  // referential integrity against the catalog all still apply, so a row pointing at
  // an ingredient that has since been renamed or removed is still an error. What is
  // gone is the *coverage* direction — see the note where that check used to be.
  "ingredient-allergen": {
    schema: IngredientAllergenMappingSchema,
    extractIngredientRefs: (record) =>
      typeof record.ingredient_id === "string" ? [record.ingredient_id] : [],
    defaultPaths: ["data/ingredient-allergens.json"],
  },
  substitution: {
    schema: SubstitutionGroupSchema,
    extractIngredientRefs: (record) =>
      Array.isArray(record.member_ingredient_ids)
        ? record.member_ingredient_ids.filter((id): id is string => typeof id === "string")
        : [],
    defaultPaths: ["data/substitutions.json"],
  },
};

export const RECORD_TYPES = Object.keys(TYPE_REGISTRY) as RecordType[];

export const DEFAULT_PATHS_BY_TYPE: Record<RecordType, string[]> = Object.fromEntries(
  RECORD_TYPES.map((type) => [type, TYPE_REGISTRY[type].defaultPaths]),
) as Record<RecordType, string[]>;

export interface FileInput {
  path: string;
  type: RecordType;
  content: string;
}

export interface ValidationIssue {
  file: string;
  index?: number;
  id?: string;
  path?: string;
  message: string;
}

export interface ValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  notes: string[];
  filesChecked: number;
  recordsChecked: number;
}

// A record's identity is usually its own "id" field, but a mapping like
// IngredientAllergenMapping has no independent id — its identity is the
// foreign key it's keyed on. Falling back to "ingredient_id" lets duplicate-id
// detection and error reporting work uniformly across both shapes.
function recordId(record: unknown): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const { id, ingredient_id } = record as { id?: unknown; ingredient_id?: unknown };
  if (typeof id === "string") return id;
  if (typeof ingredient_id === "string") return ingredient_id;
  return undefined;
}

function recordName(record: unknown): string | undefined {
  if (record && typeof record === "object" && "name" in record) {
    const name = (record as { name: unknown }).name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

interface ValidRecord {
  file: string;
  index: number;
  type: RecordType;
  record: Record<string, unknown>;
}

export function validateFiles(inputs: FileInput[]): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const notes: string[] = [];
  let recordsChecked = 0;
  const validByType = new Map<RecordType, ValidRecord[]>();

  for (const input of inputs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.content);
    } catch (cause) {
      errors.push({
        file: input.path,
        message: `malformed JSON: ${(cause as Error).message}`,
      });
      continue;
    }

    if (!Array.isArray(parsed)) {
      errors.push({
        file: input.path,
        message: "expected the file to contain a JSON array of records",
      });
      continue;
    }

    const config = TYPE_REGISTRY[input.type];
    parsed.forEach((record: unknown, index: number) => {
      recordsChecked += 1;
      const result = config.schema.safeParse(record);
      if (result.success) {
        const list = validByType.get(input.type) ?? [];
        list.push({
          file: input.path,
          index,
          type: input.type,
          record: result.data as Record<string, unknown>,
        });
        validByType.set(input.type, list);
        return;
      }

      for (const issue of result.error.issues) {
        errors.push({
          file: input.path,
          index,
          id: recordId(record),
          path: issue.path.join("."),
          message: issue.message,
        });
      }
    });
  }

  for (const type of RECORD_TYPES) {
    const records = validByType.get(type) ?? [];
    checkDuplicateIds(type, records, errors);
    checkDuplicateNames(type, records, warnings);
  }

  checkReferentialIntegrity(inputs, validByType, errors, notes);
  checkRecipeTemplateDerivedFields(inputs, validByType, errors, warnings);
  checkUnverifiedAllergenRows(validByType, warnings);
  checkSubstitutionMembersResolvable(inputs, validByType, warnings);
  checkVarietyClasses(validByType, warnings);
  checkIngredientCuisines(inputs, validByType, errors, notes);

  return {
    errors,
    warnings,
    notes,
    filesChecked: inputs.length,
    recordsChecked,
  };
}

function checkDuplicateIds(type: RecordType, records: ValidRecord[], errors: ValidationIssue[]): void {
  const byId = new Map<string, ValidRecord[]>();
  for (const entry of records) {
    const id = recordId(entry.record);
    if (!id) continue;
    const list = byId.get(id) ?? [];
    list.push(entry);
    byId.set(id, list);
  }

  for (const [id, entries] of byId) {
    if (entries.length < 2) continue;
    const locations = entries.map((e) => `${e.file}[${e.index}]`).join(", ");
    errors.push({
      file: entries[0]!.file,
      id,
      message: `duplicate ${type} id "${id}" found in: ${locations}`,
    });
  }
}

function checkDuplicateNames(type: RecordType, records: ValidRecord[], warnings: ValidationIssue[]): void {
  const byName = new Map<string, ValidRecord[]>();
  for (const entry of records) {
    const name = recordName(entry.record);
    if (!name) continue;
    const key = name.trim().toLowerCase();
    const list = byName.get(key) ?? [];
    list.push(entry);
    byName.set(key, list);
  }

  for (const [, entries] of byName) {
    if (entries.length < 2) continue;
    const locations = entries.map((e) => `${e.file}[${e.index}]`).join(", ");
    warnings.push({
      file: entries[0]!.file,
      message: `duplicate ${type} name (case/whitespace-insensitive) found in: ${locations}`,
    });
  }
}

function checkReferentialIntegrity(
  inputs: FileInput[],
  validByType: Map<RecordType, ValidRecord[]>,
  errors: ValidationIssue[],
  notes: string[],
): void {
  const ingredientFilePassed = inputs.some((i) => i.type === "ingredient");
  if (!ingredientFilePassed) {
    notes.push(
      "no ingredient file was passed in this invocation; skipping referential integrity checks against the ingredient catalog",
    );
    return;
  }

  const knownIngredientIds = new Set(
    (validByType.get("ingredient") ?? []).map((entry) => recordId(entry.record)).filter((id): id is string => !!id),
  );

  for (const type of RECORD_TYPES) {
    const extractRefs = TYPE_REGISTRY[type].extractIngredientRefs;
    if (!extractRefs) continue;

    for (const entry of validByType.get(type) ?? []) {
      for (const ingredientId of extractRefs(entry.record)) {
        if (!knownIngredientIds.has(ingredientId)) {
          errors.push({
            file: entry.file,
            index: entry.index,
            id: recordId(entry.record),
            message: `references unknown ingredient id "${ingredientId}"`,
          });
        }
      }
    }
  }
}

// DECISION_LOG.md 2026-07-31 — cost_tier and the high_protein_preference
// dietary tag are derived from ingredient_slots[], not authored:
//   - cost_tier must equal the highest default_cost_tier among slot ingredients.
//   - high_protein_preference must be present iff no slot has role "starch".
// A template whose slots reference an unresolvable ingredient id is skipped
// here — checkReferentialIntegrity already reports that, and there is no
// default_cost_tier to derive from for the missing ingredient.
function checkRecipeTemplateDerivedFields(
  inputs: FileInput[],
  validByType: Map<RecordType, ValidRecord[]>,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  const ingredientFilePassed = inputs.some((i) => i.type === "ingredient");
  if (!ingredientFilePassed) {
    warnings.push({
      file: inputs.map((i) => i.path).join(", "),
      message:
        "no ingredient file was passed in this invocation; skipping recipe-template derived-field checks (cost_tier, dietary_tags)",
    });
    return;
  }

  const ingredientCostTiers = new Map<string, CostTier>();
  for (const entry of validByType.get("ingredient") ?? []) {
    const id = recordId(entry.record);
    const tier = entry.record.default_cost_tier;
    if (id && typeof tier === "string") {
      ingredientCostTiers.set(id, tier as CostTier);
    }
  }

  for (const entry of validByType.get("recipe-template") ?? []) {
    const templateId = recordId(entry.record) ?? "(unknown id)";
    const slots = Array.isArray(entry.record.ingredient_slots)
      ? (entry.record.ingredient_slots as { role?: unknown; ingredient_id?: unknown }[])
      : [];

    const slotTiers: { ingredientId: string; tier: CostTier }[] = [];
    let hasUnresolvedIngredient = false;
    for (const slot of slots) {
      const ingredientId = typeof slot.ingredient_id === "string" ? slot.ingredient_id : undefined;
      const tier = ingredientId ? ingredientCostTiers.get(ingredientId) : undefined;
      if (!ingredientId || !tier) {
        hasUnresolvedIngredient = true;
        break;
      }
      slotTiers.push({ ingredientId, tier });
    }
    if (hasUnresolvedIngredient) continue;

    let highest = slotTiers[0]!;
    for (const slotTier of slotTiers) {
      if (COST_TIER_ORDER[slotTier.tier] > COST_TIER_ORDER[highest.tier]) highest = slotTier;
    }
    const storedTier = entry.record.cost_tier;
    if (storedTier !== highest.tier) {
      errors.push({
        file: entry.file,
        index: entry.index,
        id: templateId,
        message: `template "${templateId}": cost_tier "${String(storedTier)}" should be "${highest.tier}" (${highest.ingredientId} is ${highest.tier})`,
      });
    }

    const hasStarchSlot = slots.some((slot) => slot.role === "starch");
    const tags = Array.isArray(entry.record.dietary_tags) ? (entry.record.dietary_tags as string[]) : [];
    const hasHighProteinTag = tags.includes("high_protein_preference");
    if (hasStarchSlot && hasHighProteinTag) {
      errors.push({
        file: entry.file,
        index: entry.index,
        id: templateId,
        message: `template "${templateId}": dietary_tags includes "high_protein_preference" but has a starch slot`,
      });
    } else if (!hasStarchSlot && !hasHighProteinTag) {
      errors.push({
        file: entry.file,
        index: entry.index,
        id: templateId,
        message: `template "${templateId}": dietary_tags is missing "high_protein_preference" (no starch slot)`,
      });
    }
  }
}

// Deliberately absent: the inverse of checkReferentialIntegrity — a check that every
// ingredient in the catalog has an allergen mapping row. It enforced the 100% coverage
// the old fail-safe allergen posture needed, and #224 removed the thing it was
// protecting. Keeping it would now block the one change #224 exists to unblock: the
// first ingredient added to a catalog headed for thousands of entries would fail
// validation for lacking a row nothing reads, which is a maintenance burden charged
// for no benefit. Rows still point at real ingredients (referential integrity, above);
// ingredients no longer have to point back.

// Member resolution itself rides checkReferentialIntegrity via the type
// registry's extractIngredientRefs. That check only *notes* a skipped run when
// no ingredient file was passed; for substitution groups the whole point of the
// file is the ingredient ids it names, so a run that resolved none of them is
// warned about rather than passing quietly. Silent when there are no groups —
// an empty data/substitutions.json is valid and shouldn't produce noise.
//
// Deliberately absent: any check comparing default_cost_tier across a group's
// members. Groups are most useful precisely when members differ in tier (the
// premium→budget swap is the feature); enforcing tier homogeneity here would
// delete it. See ARCHITECTURE.md §5.5 on how this interacts with the derived
// RecipeTemplate.cost_tier rule.
function checkSubstitutionMembersResolvable(
  inputs: FileInput[],
  validByType: Map<RecordType, ValidRecord[]>,
  warnings: ValidationIssue[],
): void {
  const groups = validByType.get("substitution") ?? [];
  if (groups.length === 0) return;
  if (inputs.some((i) => i.type === "ingredient")) return;

  warnings.push({
    file: [...new Set(groups.map((entry) => entry.file))].join(", "),
    message:
      "no ingredient file was passed in this invocation; skipping substitution member resolution against the ingredient catalog",
  });
}

// `data/ingredient-allergens.json` is a closed, hand-verified record, not a working
// dataset (#224) — every row in it was manually checked, and that is the only thing
// that makes keeping the file worthwhile. A row that arrives without verification
// dilutes exactly that, so it is still worth a warning even though nothing filters on
// the data: the answer to an unverified row is to leave it out, not to ship it.
function checkUnverifiedAllergenRows(
  validByType: Map<RecordType, ValidRecord[]>,
  warnings: ValidationIssue[],
): void {
  const rows = validByType.get("ingredient-allergen") ?? [];
  const unverified = rows.filter((entry) => entry.record.verification_status === "unverified");
  if (unverified.length === 0) return;

  const files = [...new Set(rows.map((entry) => entry.file))].join(", ");
  warnings.push({
    file: files,
    message:
      `${unverified.length} of ${rows.length} ingredient-allergen row(s) are unverified — ` +
      `this file is a hand-verified record kept unread by the product (#224); an ` +
      `unverified row belongs out of it, not in it`,
  });
}

// A variety class of one is always a curation slip (#221): either a typo in the key,
// or the sibling it was written for never landed. It is silent rather than loud in the
// engine — `variety_of` is only ever compared for equality, so a lone key simply never
// matches anything, and the ingredient quietly stops being covered by the sibling that
// was supposed to cover it. The validator is the only place that can see it.
//
// A *warning* and not an error: a lone key breaks nothing that was working, and a
// half-finished curation pass must still be committable. Deliberately absent, for the
// same reason as the cost-tier check above: anything comparing a class against the
// substitution groups. The two relations are independent by design — the whole point
// of #221 is that group membership is the wider one — so a class whose members share no
// group is not wrong, only inert.
function checkVarietyClasses(
  validByType: Map<RecordType, ValidRecord[]>,
  warnings: ValidationIssue[],
): void {
  const membersByKey = new Map<string, ValidRecord[]>();
  for (const entry of validByType.get("ingredient") ?? []) {
    const key = entry.record.variety_of;
    if (typeof key !== "string") continue;
    const members = membersByKey.get(key) ?? [];
    members.push(entry);
    membersByKey.set(key, members);
  }

  for (const [key, members] of membersByKey) {
    if (members.length > 1) continue;
    const entry = members[0]!;
    warnings.push({
      file: entry.file,
      index: entry.index,
      id: recordId(entry.record),
      path: "variety_of",
      message: `variety_of "${key}" has only this one member — a variety class of one never matches anything`,
    });
  }
}

// #222 — `Ingredient.cuisines` says "belongs *only* in these kitchens", and the recipe
// templates are the other half of the same curated record. If a template of cuisine X
// puts an ingredient in a slot, then X is a kitchen that ingredient belongs in, and a
// list omitting it makes the two files contradict each other.
//
// An error rather than a warning, unlike `checkVarietyClasses` above: this one has a
// behavioural consequence that is invisible from the outside. `substituteCandidateIds`
// filters candidates, not the current ingredient, so the contradiction shows up as a
// one-way door — the household can swap away from the ingredient its own dish named
// and is then never offered it back. Cheap to resolve in either direction: add the
// cuisine, or drop the mark.
function checkIngredientCuisines(
  inputs: FileInput[],
  validByType: Map<RecordType, ValidRecord[]>,
  errors: ValidationIssue[],
  notes: string[],
): void {
  const marked = (validByType.get("ingredient") ?? []).filter((entry) => Array.isArray(entry.record.cuisines));
  if (marked.length === 0) return;

  if (!inputs.some((i) => i.type === "recipe-template")) {
    notes.push(
      "no recipe-template file was passed in this invocation; skipping the ingredient cuisines check against template usage",
    );
    return;
  }

  const templateCuisinesByIngredient = new Map<string, Set<string>>();
  for (const entry of validByType.get("recipe-template") ?? []) {
    const cuisine = entry.record.cuisine;
    if (typeof cuisine !== "string" || !Array.isArray(entry.record.ingredient_slots)) continue;
    for (const slot of entry.record.ingredient_slots) {
      const ingredientId = (slot as { ingredient_id?: unknown })?.ingredient_id;
      if (typeof ingredientId !== "string") continue;
      const cuisines = templateCuisinesByIngredient.get(ingredientId) ?? new Set<string>();
      cuisines.add(cuisine);
      templateCuisinesByIngredient.set(ingredientId, cuisines);
    }
  }

  for (const entry of marked) {
    const id = recordId(entry.record);
    if (!id) continue;
    const declared = new Set(entry.record.cuisines as string[]);
    const used = [...(templateCuisinesByIngredient.get(id) ?? [])].filter((cuisine) => !declared.has(cuisine)).sort();
    if (used.length === 0) continue;
    errors.push({
      file: entry.file,
      index: entry.index,
      id,
      path: "cuisines",
      message:
        `recipe templates of cuisine ${used.map((cuisine) => `"${cuisine}"`).join(", ")} use this ingredient, ` +
        `but its cuisines list omits ${used.length === 1 ? "it" : "them"} — the two curated files disagree`,
    });
  }
}
