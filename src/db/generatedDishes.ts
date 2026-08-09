import type { GeneratedDishOutput } from "../schema/generatedDish.js";
import type { Sql } from "./client.js";

// Tier 2 generation cache repository (issue #113). Like recipeInstructions.ts, this
// never runs through withUserContext — the table carries no RLS and no user
// context, keyed purely on generator version + query, so it's a plain Sql query
// rather than a transaction. See the migration
// (20260809000000_tier2_dish_generation.sql) and DECISION_LOG 2026-08-09.

// Bumped whenever the prompt, the output schema, or the resolution algorithm
// changes — a row produced under old rules must never be replayed under new ones.
// The single place this value is chosen; everything else imports it.
export const GENERATOR_VERSION = 1;

/**
 * Canonical cache key for a free-text dish query: NFC-normalized, lowercased,
 * whitespace-collapsed, with trailing punctuation stripped. Applied identically
 * before every read and write (here, and nowhere else), so equality in the database
 * is a plain text compare.
 */
export function buildQueryKey(query: string): string {
  return query
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "");
}

/** A cache hit's stored model output, or undefined on a miss. Never throws on a miss. */
export async function getCachedGeneratedDish(
  sql: Sql,
  queryKey: string,
): Promise<GeneratedDishOutput | undefined> {
  const [row] = await sql<{ output: GeneratedDishOutput }[]>`
    select output
    from generated_dishes
    where generator_version = ${GENERATOR_VERSION}
      and query_key = ${queryKey}
  `;

  return row?.output;
}

/**
 * Writes a freshly generated result to the cache. `on conflict ... do nothing`
 * because two concurrent requests for the same never-before-cached key can both miss
 * and both generate — the second write is a silent no-op, not an error, since the
 * first writer's row is just as valid a cache entry (same rationale as
 * recipeInstructions.ts's insertCachedInstructions).
 */
export async function insertGeneratedDish(
  sql: Sql,
  queryKey: string,
  output: GeneratedDishOutput,
): Promise<void> {
  await sql`
    insert into generated_dishes (generator_version, query_key, output)
    values (${GENERATOR_VERSION}, ${queryKey}, ${sql.json(output)})
    on conflict (generator_version, query_key) do nothing
  `;
}

/**
 * Number of Tier 2 generation attempts recorded in the last 24 hours — the global
 * daily spend ceiling's input (DECISION_LOG 2026-08-05 / 2026-08-09). A sliding
 * 24-hour window, not a calendar-day count, so the ceiling can't be trivially reset
 * by waiting until local midnight.
 */
export async function countGenerationAttemptsLast24h(sql: Sql): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*) as count
    from dish_generation_attempts
    where created_at > now() - interval '24 hours'
  `;

  return Number(row?.count ?? 0);
}

/**
 * Records one attempted generation call, before the Anthropic API is actually
 * called — the ceiling counts money that could be spent, not just successful
 * generations, so a timeout or an API error still counts against it.
 */
export async function recordGenerationAttempt(sql: Sql): Promise<void> {
  await sql`insert into dish_generation_attempts default values`;
}
