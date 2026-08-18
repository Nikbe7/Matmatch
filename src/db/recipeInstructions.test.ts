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

  it("gives two different substitution sets two different keys", () => {
    const a = buildSubstitutionKey([{ slot_index: 0, substitute_ingredient_id: "kyckling" }]);
    const b = buildSubstitutionKey([{ slot_index: 0, substitute_ingredient_id: "tofu" }]);

    expect(a).not.toEqual(b);
  });

  it("is stable across repeated calls for the same set", () => {
    const substitutions = [
      { slot_index: 1, substitute_ingredient_id: "tofu" },
      { slot_index: 0, substitute_ingredient_id: "morot" },
    ];

    expect(buildSubstitutionKey(substitutions)).toEqual(buildSubstitutionKey([...substitutions].reverse()));
  });

  /**
   * The portion count is not an input to this function and must never become one
   * (#154). Scaling is deterministic and happens at render time from curated slot
   * quantities (`scaleSlotQuantity`), so a two-person household and a six-person
   * household cook the same dish from the same prose and share one cache row —
   * putting portions in the key would multiply generations (and cost) by the number
   * of distinct household sizes for no difference in output.
   *
   * Asserted structurally, since there is no portions parameter to vary: the key for
   * a substitution set depends on that set alone, so nothing about the household can
   * reach it.
   */
  it("does not vary with portions — the key is a function of the substitution set alone", () => {
    const substitutions = [{ slot_index: 0, substitute_ingredient_id: "tofu" }];

    expect(buildSubstitutionKey.length).toBe(1);
    for (const portions of [1, 2.7, 4, 6.5]) {
      void portions;
      expect(buildSubstitutionKey(substitutions)).toEqual(["0:tofu"]);
    }
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

  it("a second write for the same key replaces rather than erroring", async () => {
    const templateId = `test-template-${crypto.randomUUID()}`;
    const key = buildSubstitutionKey([]);

    await insertCachedInstructions(sql!, templateId, key, ["First.", "F2.", "F3.", "F4.", "F5.", "F6."]);
    await expect(
      insertCachedInstructions(sql!, templateId, key, ["Second.", "S2.", "S3.", "S4.", "S5.", "S6."]),
    ).resolves.toBeUndefined();

    // A collision must never be an error — two concurrent misses can both generate,
    // and either result is a valid entry. Last writer wins as of #154: the route
    // regenerates when a cached row fails validation, and under the previous
    // "do nothing" the rejected row would have survived its own replacement and been
    // discarded again on every later request.
    expect(await getCachedInstructions(sql!, templateId, key)).toEqual([
      "Second.",
      "S2.",
      "S3.",
      "S4.",
      "S5.",
      "S6.",
    ]);
  });
});
