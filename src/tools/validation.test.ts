import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateFiles, type FileInput, type RecordType } from "./validation.js";

const fixturesDir = fileURLToPath(new URL("./__fixtures__/", import.meta.url));

function fixture(name: string, type: RecordType): FileInput {
  return {
    path: `__fixtures__/${name}`,
    type,
    content: readFileSync(`${fixturesDir}${name}`, "utf-8"),
  };
}

describe("validateFiles", () => {
  it("passes a valid ingredient and recipe-template batch with no errors or warnings", () => {
    const result = validateFiles([
      fixture("valid-ingredients.json", "ingredient"),
      fixture("valid-recipe-templates.json", "recipe-template"),
    ]);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.filesChecked).toBe(2);
    expect(result.recordsChecked).toBe(3);
  });

  it("fails an invalid enum value with the correct issue path", () => {
    const result = validateFiles([fixture("invalid-enum-ingredient.json", "ingredient")]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ path: "category", id: "fisk" });
  });

  it("fails a record missing a required field", () => {
    const result = validateFiles([fixture("missing-field-ingredient.json", "ingredient")]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ path: "seasonality_strength" });
  });

  it("fails a malformed id slug", () => {
    const result = validateFiles([fixture("bad-slug-ingredient.json", "ingredient")]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ path: "id" });
  });

  it("fails on duplicate id across two separate files", () => {
    const result = validateFiles([
      fixture("dup-id-ingredients-a.json", "ingredient"),
      fixture("dup-id-ingredients-b.json", "ingredient"),
    ]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain('duplicate ingredient id "gul-lok"');
  });

  it("warns (but does not error) on duplicate name across files", () => {
    const result = validateFiles([
      fixture("dup-name-ingredients-a.json", "ingredient"),
      fixture("dup-name-ingredients-b.json", "ingredient"),
    ]);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.message).toContain("duplicate ingredient name");
  });

  it("fails a recipe template referencing a nonexistent ingredient id", () => {
    const result = validateFiles([
      fixture("valid-ingredients.json", "ingredient"),
      fixture("recipe-template-missing-ingredient.json", "recipe-template"),
    ]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain('references unknown ingredient id "nonexistent-ingredient"');
  });

  it("skips referential integrity checks and notes it when no ingredient file is passed", () => {
    const result = validateFiles([fixture("recipe-template-missing-ingredient.json", "recipe-template")]);

    expect(result.errors).toEqual([]);
    expect(result.notes.some((note) => note.includes("no ingredient file was passed"))).toBe(true);
  });

  it("reports non-array JSON as a clear error, not a stack trace", () => {
    const result = validateFiles([fixture("non-array.json", "ingredient")]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain("expected the file to contain a JSON array");
  });

  it("reports malformed JSON as a clear error, not a stack trace", () => {
    const result = validateFiles([fixture("malformed.json", "ingredient")]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain("malformed JSON");
  });

  it("reports multiple independent errors within a single file in one run", () => {
    const result = validateFiles([
      fixture("invalid-enum-ingredient.json", "ingredient"),
      fixture("bad-slug-ingredient.json", "ingredient"),
    ]);

    expect(result.errors).toHaveLength(2);
  });
});
