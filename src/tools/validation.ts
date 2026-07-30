import type { z } from "zod";
import { IngredientSchema } from "../schema/ingredient.js";
import { RecipeTemplateSchema } from "../schema/recipeTemplate.js";

export type RecordType = "ingredient" | "recipe-template";

interface TypeConfig {
  schema: z.ZodType;
  // Ingredient ids this record references, for cross-file referential checks
  // against the ingredient catalog. Omitted for types that reference nothing.
  extractIngredientRefs?: (record: Record<string, unknown>) => string[];
}

const TYPE_REGISTRY: Record<RecordType, TypeConfig> = {
  ingredient: { schema: IngredientSchema },
  "recipe-template": {
    schema: RecipeTemplateSchema,
    extractIngredientRefs: (record) =>
      Array.isArray(record.ingredient_slots)
        ? record.ingredient_slots
            .map((slot) => (slot as { ingredient_id?: unknown })?.ingredient_id)
            .filter((id): id is string => typeof id === "string")
        : [],
  },
};

export const RECORD_TYPES = Object.keys(TYPE_REGISTRY) as RecordType[];

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

function recordId(record: unknown): string | undefined {
  if (record && typeof record === "object" && "id" in record) {
    const id = (record as { id: unknown }).id;
    return typeof id === "string" ? id : undefined;
  }
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
