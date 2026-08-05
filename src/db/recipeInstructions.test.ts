import { afterAll, describe, expect, it } from "vitest";
import type { Sql } from "./client.js";
import {
  buildSubstitutionKey,
  getCachedInstructions,
  insertCachedInstructions,
} from "./recipeInstructions.js";
import { appClient, isLocalStackAvailable } from "./__fixtures__/localStack.js";

// Runs against the real local Supabase stack, connected as matmatch_app — the same
// role the backend uses. This is what actually proves the migration's GRANT works:
// a mock would only prove this file's SQL matches its own expectations, never that
// matmatch_app can read and write the table for real (DECISION_LOG 2026-08-03's
// grant/TO-clause trap is exactly the failure mode a mock can't catch).

const stackAvailable = await isLocalStackAvailable();
const sql: Sql | undefined = stackAvailable ? appClient() : undefined;

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describe("buildSubstitutionKey", () => {
  it("sorts by slot_index regardless of input order", () => {
    const key = buildSubstitutionKey([
      { slot_index: 2, substitute_ingredient_id: "morot" },
      { slot_index: 0, substitute_ingredient_id: "kyckling" },
    ]);

    expect(key).toEqual(["0:kyckling", "2:morot"]);
  });

  it("keys different slots swapped to the same ingredient differently", () => {
    const a = buildSubstitutionKey([{ slot_index: 0, substitute_ingredient_id: "agg" }]);
    const b = buildSubstitutionKey([{ slot_index: 1, substitute_ingredient_id: "agg" }]);

    expect(a).not.toEqual(b);
  });
});

describe.skipIf(!stackAvailable)("recipe_instructions cache (local Supabase)", () => {
  it("round-trips a cached result for matmatch_app, the backend's own role", async () => {
    const templateId = `test-template-${crypto.randomUUID()}`;
    const key = buildSubstitutionKey([]);
    const steps = ["Steg ett.", "Steg två.", "Steg tre.", "Steg fyra.", "Steg fem.", "Steg sex."];

    expect(await getCachedInstructions(sql!, templateId, key)).toBeUndefined();

    await insertCachedInstructions(sql!, templateId, key, steps);

    expect(await getCachedInstructions(sql!, templateId, key)).toEqual(steps);
  });

  it("shares one cache row for the no-substitution case, keeps a swapped set separate", async () => {
    const templateId = `test-template-${crypto.randomUUID()}`;
    const noSub = buildSubstitutionKey([]);
    const swapped = buildSubstitutionKey([{ slot_index: 0, substitute_ingredient_id: "morot" }]);
    const stepsNoSub = ["A.", "B.", "C.", "D.", "E.", "F."];
    const stepsSwapped = ["G.", "H.", "I.", "J.", "K.", "L."];

    await insertCachedInstructions(sql!, templateId, noSub, stepsNoSub);
    await insertCachedInstructions(sql!, templateId, swapped, stepsSwapped);

    expect(await getCachedInstructions(sql!, templateId, noSub)).toEqual(stepsNoSub);
    expect(await getCachedInstructions(sql!, templateId, swapped)).toEqual(stepsSwapped);
  });

  it("a second write for the same key is a silent no-op, not an error", async () => {
    const templateId = `test-template-${crypto.randomUUID()}`;
    const key = buildSubstitutionKey([]);

    await insertCachedInstructions(sql!, templateId, key, ["First.", "F2.", "F3.", "F4.", "F5.", "F6."]);
    await expect(
      insertCachedInstructions(sql!, templateId, key, ["Second.", "S2.", "S3.", "S4.", "S5.", "S6."]),
    ).resolves.toBeUndefined();

    // The first writer's row wins — on conflict do nothing.
    expect(await getCachedInstructions(sql!, templateId, key)).toEqual([
      "First.",
      "F2.",
      "F3.",
      "F4.",
      "F5.",
      "F6.",
    ]);
  });
});
