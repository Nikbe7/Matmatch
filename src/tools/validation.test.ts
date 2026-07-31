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

describe("validateFiles — ingredient-allergen coverage", () => {
  it("passes when every catalog ingredient has a verified mapping row", () => {
    const result = validateFiles([
      fixture("valid-ingredients.json", "ingredient"),
      fixture("valid-ingredient-allergens.json", "ingredient-allergen"),
    ]);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("fails a mapping row referencing a nonexistent ingredient id", () => {
    // The fixture only maps "nonexistent-ingredient", so the coverage check
    // also fires (gul-lok/kyckling are uncovered) alongside the referential
    // check under test here — both are correct, independent findings.
    const result = validateFiles([
      fixture("valid-ingredients.json", "ingredient"),
      fixture("ingredient-allergen-missing-ingredient.json", "ingredient-allergen"),
    ]);

    expect(
      result.errors.some((error) => error.message.includes('references unknown ingredient id "nonexistent-ingredient"')),
    ).toBe(true);
  });

  it("fails coverage when a catalog ingredient has no mapping row at all", () => {
    const result = validateFiles([
      fixture("valid-ingredients.json", "ingredient"),
      fixture("ingredient-allergen-partial-coverage.json", "ingredient-allergen"),
    ]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain('ingredient "kyckling" has no ingredient-allergen mapping row');
  });

  it("skips the coverage check and notes it when no ingredient file is passed", () => {
    const result = validateFiles([fixture("valid-ingredient-allergens.json", "ingredient-allergen")]);

    expect(result.errors).toEqual([]);
    expect(
      result.notes.some((note) => note.includes("no ingredient file was passed") && note.includes("coverage")),
    ).toBe(true);
  });

  it("skips the coverage check and notes it when no ingredient-allergen file is passed", () => {
    const result = validateFiles([fixture("valid-ingredients.json", "ingredient")]);

    expect(result.errors).toEqual([]);
    expect(
      result.notes.some(
        (note) => note.includes("no ingredient-allergen file was passed") && note.includes("coverage"),
      ),
    ).toBe(true);
  });

  it("warns with an unverified-row count, without erroring, and does not affect exit-worthy status", () => {
    const result = validateFiles([
      fixture("valid-ingredients.json", "ingredient"),
      fixture("ingredient-allergen-unverified.json", "ingredient-allergen"),
    ]);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.message).toContain("1 of 2 ingredient-allergen row(s) are unverified");
  });

  it("fails on duplicate ingredient_id in the mapping across files", () => {
    const result = validateFiles([
      fixture("dup-id-ingredient-allergens-a.json", "ingredient-allergen"),
      fixture("dup-id-ingredient-allergens-b.json", "ingredient-allergen"),
    ]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain('duplicate ingredient-allergen id "gul-lok"');
  });
});
