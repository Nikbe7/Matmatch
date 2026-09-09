import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, parseArgs, resolveDefaultTargets } from "./validate.js";

const fixturesDir = fileURLToPath(new URL("./__fixtures__/", import.meta.url));

describe("parseArgs", () => {
  it("assigns --type to every path that follows it", async () => {
    const targets = await parseArgs([
      "--type",
      "ingredient",
      `${fixturesDir}valid-ingredients.json`,
      "--type",
      "recipe-template",
      `${fixturesDir}valid-recipe-templates.json`,
    ]);

    expect(targets).toEqual([
      { path: `${fixturesDir}valid-ingredients.json`, type: "ingredient" },
      { path: `${fixturesDir}valid-recipe-templates.json`, type: "recipe-template" },
    ]);
  });

  it("rejects an unknown --type value", async () => {
    await expect(parseArgs(["--type", "bogus", "file.json"])).rejects.toThrow(/--type must be one of/);
  });

  it("rejects a path given before any --type flag", async () => {
    await expect(parseArgs(["file.json"])).rejects.toThrow(/no --type specified/);
  });

  it("expands a glob pattern to matching paths", async () => {
    const targets = await parseArgs(["--type", "ingredient", `${fixturesDir}dup-id-ingredients-*.json`]);

    expect(targets.map((t) => t.path).sort()).toEqual(
      [`${fixturesDir}dup-id-ingredients-a.json`, `${fixturesDir}dup-id-ingredients-b.json`].sort(),
    );
  });
});

describe("resolveDefaultTargets", () => {
  let originalCwd: string;
  let dir: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    dir = await mkdtemp(path.join(tmpdir(), "matmatch-validate-"));
    await mkdir(path.join(dir, "data"));
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  });

  it("picks up every existing default data file under its registered type", async () => {
    await writeFile(path.join(dir, "data", "ingredients.json"), "[]");
    await writeFile(path.join(dir, "data", "recipe-templates.json"), "[]");
    await writeFile(path.join(dir, "data", "ingredient-allergens.json"), "[]");
    await writeFile(path.join(dir, "data", "substitutions.json"), "[]");
    await writeFile(path.join(dir, "data", "variety-families.json"), "[]");

    const { targets, notes } = await resolveDefaultTargets();

    expect(targets.map((t) => t.type).sort()).toEqual([
      "ingredient",
      "ingredient-allergen",
      "recipe-template",
      "substitution",
      "variety-family",
    ]);
    expect(notes).toEqual([]);
  });

  it("skips a missing default data file with a note instead of an error", async () => {
    await writeFile(path.join(dir, "data", "ingredients.json"), "[]");
    // recipe-templates.json, ingredient-allergens.json and variety-families.json
    // intentionally absent

    const { targets, notes } = await resolveDefaultTargets();

    expect(targets).toEqual([{ path: "data/ingredients.json", type: "ingredient" }]);
    expect(notes).toContain("default data file data/recipe-templates.json does not exist; skipping");
    expect(notes).toContain("default data file data/ingredient-allergens.json does not exist; skipping");
    expect(notes).toContain("default data file data/variety-families.json does not exist; skipping");
  });

  it("picks up ingredient files split under data/ingredients/*.json alongside data/ingredients.json", async () => {
    await writeFile(path.join(dir, "data", "ingredients.json"), "[]");
    await mkdir(path.join(dir, "data", "ingredients"));
    await writeFile(path.join(dir, "data", "ingredients", "batch-1.json"), "[]");

    const { targets } = await resolveDefaultTargets();

    expect(targets).toContainEqual({ path: "data/ingredients/batch-1.json", type: "ingredient" });
  });

  it("does not note a split-ingredients glob that simply has no matches", async () => {
    await writeFile(path.join(dir, "data", "ingredients.json"), "[]");
    await writeFile(path.join(dir, "data", "recipe-templates.json"), "[]");
    await writeFile(path.join(dir, "data", "ingredient-allergens.json"), "[]");

    const { notes } = await resolveDefaultTargets();

    expect(notes.some((note) => note.includes("ingredients/*.json"))).toBe(false);
  });

  it("main() with no args validates present default files, skips missing ones, and exits 0", async () => {
    await writeFile(path.join(dir, "data", "ingredients.json"), "[]");
    // recipe-templates.json and ingredient-allergens.json intentionally absent

    const code = await main([]);

    expect(code).toBe(0);
  });
});

describe("main — explicit invocation unaffected by default-mode resolution", () => {
  it("still validates and fails on an invalid explicit fixture", async () => {
    const code = await main(["--type", "ingredient", `${fixturesDir}invalid-enum-ingredient.json`]);

    expect(code).toBe(1);
  });

  it("still validates and passes on a valid explicit fixture", async () => {
    const code = await main(["--type", "ingredient", `${fixturesDir}valid-ingredients.json`]);

    expect(code).toBe(0);
  });
});
