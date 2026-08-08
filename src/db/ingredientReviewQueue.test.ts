import { afterAll, describe, expect, it } from "vitest";
import type { Sql } from "./client.js";
import { recordUnresolvedIngredient } from "./ingredientReviewQueue.js";
import { appClient, isLocalStackAvailable } from "./__fixtures__/localStack.js";

const stackAvailable = await isLocalStackAvailable();
const sql: Sql | undefined = stackAvailable ? appClient() : undefined;

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describe.skipIf(!stackAvailable)("ingredient_review_queue (local Supabase)", () => {
  it("creates a row on first sighting, for matmatch_app, the backend's own role", async () => {
    const name = `flygande fisk ${crypto.randomUUID()}`;

    await recordUnresolvedIngredient(sql!, name, "protein");

    const [row] = await sql!<{ proposed_name: string; role: string; seen_count: number }[]>`
      select proposed_name, role, seen_count from ingredient_review_queue where proposed_name = ${name}
    `;
    expect(row).toEqual({ proposed_name: name, role: "protein", seen_count: 1 });
  });

  it("bumps seen_count on a repeat sighting instead of creating a second row", async () => {
    const name = `annan okänd ingrediens ${crypto.randomUUID()}`;

    await recordUnresolvedIngredient(sql!, name, "vegetable");
    await recordUnresolvedIngredient(sql!, name, "vegetable");
    await recordUnresolvedIngredient(sql!, name, "vegetable");

    const rows = await sql!<{ seen_count: number }[]>`
      select seen_count from ingredient_review_queue where proposed_name = ${name}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seen_count).toBe(3);
  });
});
