import { afterAll, describe, expect, it } from "vitest";
import type { GeneratedDishOutput } from "../schema/generatedDish.js";
import type { Sql } from "./client.js";
import {
  buildQueryKey,
  countGenerationAttemptsLast24h,
  getCachedGeneratedDish,
  insertGeneratedDish,
  recordGenerationAttempt,
} from "./generatedDishes.js";
import { appClient, isLocalStackAvailable } from "./__fixtures__/localStack.js";

// Runs against the real local Supabase stack, connected as matmatch_app — same
// rationale as recipeInstructions.test.ts: a mock only proves this file's SQL
// matches its own expectations, never that matmatch_app can read and write these
// tables for real (the exact class of bug DECISION_LOG 2026-08-07/#99 found).

const stackAvailable = await isLocalStackAvailable();
const sql: Sql | undefined = stackAvailable ? appClient() : undefined;

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

function dishOutput(overrides: Partial<GeneratedDishOutput> = {}): GeneratedDishOutput {
  return {
    name: "Kycklinggryta",
    cuisine: "swedish_nordic",
    prep_time_band: "20-40min",
    protein_group: "chicken_poultry",
    meal_types: ["dinner"],
    familiarity: "everyday",
    ingredients: [{ role: "protein", name: "kyckling" }],
    ...overrides,
  };
}

describe("buildQueryKey", () => {
  it("normalizes case, whitespace, and trailing punctuation identically", () => {
    expect(buildQueryKey("  Kycklinggryta Med Curry!  ")).toBe(buildQueryKey("kycklinggryta med curry"));
    expect(buildQueryKey("kyckling   gryta")).toBe(buildQueryKey("kyckling gryta"));
  });

  it("does not fold away accents — different words stay different keys", () => {
    expect(buildQueryKey("räkor")).not.toBe(buildQueryKey("rakor"));
  });
});

describe.skipIf(!stackAvailable)("generated_dishes cache (local Supabase)", () => {
  it("round-trips a cached result for matmatch_app, the backend's own role", async () => {
    const key = buildQueryKey(`test query ${crypto.randomUUID()}`);
    const output = dishOutput();

    expect(await getCachedGeneratedDish(sql!, key)).toBeUndefined();

    await insertGeneratedDish(sql!, key, output);

    expect(await getCachedGeneratedDish(sql!, key)).toEqual(output);
  });

  it("a second write for the same key is a silent no-op, not an error", async () => {
    const key = buildQueryKey(`test query ${crypto.randomUUID()}`);

    await insertGeneratedDish(sql!, key, dishOutput({ name: "First" }));
    await expect(insertGeneratedDish(sql!, key, dishOutput({ name: "Second" }))).resolves.toBeUndefined();

    // The first writer's row wins — on conflict do nothing. This is exactly the
    // property DECISION_LOG 2026-08-09's cache-key design depends on for safety:
    // once a query_key has a row, every later read (any household) sees the same
    // model output, which is what makes the safety recomputation on read
    // trustworthy rather than racing a second generation.
    expect((await getCachedGeneratedDish(sql!, key))?.name).toBe("First");
  });

  it("two distinct query keys never collide", async () => {
    const keyA = buildQueryKey(`test query a ${crypto.randomUUID()}`);
    const keyB = buildQueryKey(`test query b ${crypto.randomUUID()}`);

    await insertGeneratedDish(sql!, keyA, dishOutput({ name: "A" }));
    await insertGeneratedDish(sql!, keyB, dishOutput({ name: "B" }));

    expect((await getCachedGeneratedDish(sql!, keyA))?.name).toBe("A");
    expect((await getCachedGeneratedDish(sql!, keyB))?.name).toBe("B");
  });
});

describe.skipIf(!stackAvailable)("dish_generation_attempts ceiling counter (local Supabase)", () => {
  it("counts recorded attempts within the last 24 hours", async () => {
    const before = await countGenerationAttemptsLast24h(sql!);

    await recordGenerationAttempt(sql!);
    await recordGenerationAttempt(sql!);

    expect(await countGenerationAttemptsLast24h(sql!)).toBe(before + 2);
  });
});
