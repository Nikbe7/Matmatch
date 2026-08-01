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
  checkAllergenCoverage(inputs, validByType, errors, warnings, notes);
  checkUnverifiedAllergenRows(validByType, warnings);
  checkSubstitutionMembersResolvable(inputs, validByType, warnings);

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

// The inverse of checkReferentialIntegrity: every ingredient in the catalog
// must have an allergen mapping row. A catalog id with no row is the most
// likely real-world way the fail-safe allergen posture (ARCHITECTURE.md §5.4)
// gets silently broken — an ingredient added in #6 and never mapped in #8/#9.
function checkAllergenCoverage(
  inputs: FileInput[],
  validByType: Map<RecordType, ValidRecord[]>,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
  notes: string[],
): void {
  const ingredientFilePassed = inputs.some((i) => i.type === "ingredient");
  if (!ingredientFilePassed) {
    warnings.push({
      file: inputs.map((i) => i.path).join(", "),
      message: "no ingredient file was passed in this invocation; skipping allergen mapping coverage check",
    });
    return;
  }

  const allergenFilePassed = inputs.some((i) => i.type === "ingredient-allergen");
  if (!allergenFilePassed) {
    notes.push(
      "no ingredient-allergen file was passed in this invocation; skipping allergen mapping coverage check",
    );
    return;
  }

  const mappedIngredientIds = new Set(
    (validByType.get("ingredient-allergen") ?? [])
      .map((entry) => recordId(entry.record))
      .filter((id): id is string => !!id),
  );

  for (const entry of validByType.get("ingredient") ?? []) {
    const ingredientId = recordId(entry.record);
    if (ingredientId && !mappedIngredientIds.has(ingredientId)) {
      errors.push({
        file: entry.file,
        index: entry.index,
        id: ingredientId,
        message: `ingredient "${ingredientId}" has no ingredient-allergen mapping row`,
      });
    }
  }
}

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
      `#9 requires 100% manual verification before any allergen-dependent code ships`,
  });
}
