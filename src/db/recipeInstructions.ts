import type { Sql } from "./client.js";

// Cache repository for Tier 1 cooking instructions (issue #78). Unlike households.ts,
// this never runs through withUserContext — the table carries no RLS and no user
// context to set (DECISION_LOG 2026-08-05); it is keyed purely on template +
// substitution set, which is why it's a plain Sql query rather than a transaction.

export interface SubstitutionRef {
  slot_index: number;
  substitute_ingredient_id: string;
}

/**
 * Canonical cache key for a substitution set: sorted "slot_index:ingredient_id"
 * pairs. Slot index is part of the key (not just the ingredient id) so that two
 * different slots swapped to the same ingredient never collide — see the migration
 * comment and DECISION_LOG 2026-08-05. Sorting is numeric by slot_index, applied here
 * and nowhere else, so every caller that builds a key for the same substitution set
 * gets byte-identical output regardless of the order substitutions arrived in.
 */
export function buildSubstitutionKey(substitutions: readonly SubstitutionRef[]): string[] {
  return [...substitutions]
    .sort((a, b) => a.slot_index - b.slot_index)
    .map((s) => `${s.slot_index}:${s.substitute_ingredient_id}`);
}

/** A cache hit's stored steps, or undefined on a miss. Never throws on a miss. */
export async function getCachedInstructions(
  sql: Sql,
  templateId: string,
  substitutionKey: readonly string[],
): Promise<string[] | undefined> {
  const [row] = await sql<{ steps: string[] }[]>`
    select steps
    from recipe_instructions
    where template_id = ${templateId}
      and substitution_key = ${[...substitutionKey]}::text[]
  `;

  return row?.steps;
}

/**
 * Writes a freshly generated result to the cache.
 *
 * An upsert rather than `on conflict do nothing`: two concurrent requests for the
 * same never-before-cached key can both miss and both generate, and either result is
 * an equally valid entry, so a collision must never be an error. It became a
 * *replace* with #154, because the route now also regenerates when a cached row
 * fails validation — under `do nothing` that row would be rewritten as itself and
 * every later request would discard and regenerate it again, forever.
 */
export async function insertCachedInstructions(
  sql: Sql,
  templateId: string,
  substitutionKey: readonly string[],
  steps: readonly string[],
): Promise<void> {
  await sql`
    insert into recipe_instructions (template_id, substitution_key, steps)
    values (${templateId}, ${[...substitutionKey]}::text[], ${sql.json([...steps])})
    on conflict (template_id, substitution_key) do update set steps = excluded.steps
  `;
}
