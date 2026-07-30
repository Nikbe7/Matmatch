import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseArgs } from "./validate.js";

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
