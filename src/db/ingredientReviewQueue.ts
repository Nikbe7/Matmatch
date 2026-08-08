import type { Sql } from "./client.js";

// Tier 2 unresolved-ingredient review queue repository (issue #113). Same posture
// as generatedDishes.ts: no RLS, no user context, plain Sql queries.

/**
 * Records that the model proposed an ingredient name that didn't resolve against
 * the catalog. Deduplicated by name: a repeat sighting bumps seen_count and
 * last_seen_at rather than creating a new row, so a name that keeps coming up is
 * visibly more urgent than one seen once — the signal DECISION_LOG 2026-08-05's
 * "a repeated miss on the same dish is what triggers a deliberate, reviewed
 * template batch" depends on.
 */
export async function recordUnresolvedIngredient(sql: Sql, proposedName: string, role: string): Promise<void> {
  await sql`
    insert into ingredient_review_queue (proposed_name, role)
    values (${proposedName}, ${role})
    on conflict (proposed_name) do update
      set seen_count = ingredient_review_queue.seen_count + 1,
          last_seen_at = now()
  `;
}
