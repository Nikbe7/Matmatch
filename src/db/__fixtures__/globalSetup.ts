import { bypassClient, isLocalStackAvailable } from "./localStack.js";

// Vitest's globalSetup (wired in vitest.config.ts) — runs once in the main process
// before any test file starts, not a per-file `beforeAll`. That matters here
// specifically: a per-file reset in dishGenerate.test.ts would risk deleting rows
// out from under generatedDishes.test.ts's own relative-delta assertions on the
// same table if vitest ever schedules the two files concurrently. Running once,
// before anything starts, avoids that race entirely.
//
// `dish_generation_attempts` backs the Tier 2 generation ceiling (#155,
// src/api/routes/dishGenerate.ts's `countGenerationAttemptsLast24h`/
// `DEFAULT_DAILY_GENERATION_LIMIT`) with no per-row owner and no household scope —
// migration 20260809000000_tier2_dish_generation.sql's own comment: "none holding
// household data or a per-row owner". Real rows accumulate here across every
// `npm test` run against the same local Supabase instance (it is never reset
// between invocations), and once the accumulated 24h count crosses the ceiling,
// every test that exercises a real cache-miss path spuriously receives
// `generation_limit` instead of the outcome it's actually testing. A full reset is
// safe precisely because nothing else has a claim on these rows — production code
// never deletes from this table, and this fixture is test-only (imports the
// RLS-bypassing role, unreachable from application code).
//
// `generated_dishes` and `ingredient_review_queue` share the same "no owner, never
// cleaned up" shape (see dishGenerate.test.ts's own comment) but were checked and
// found not to need this: every test that touches them keys its rows with
// `crypto.randomUUID()`, so accumulated rows from earlier runs can never collide
// with or be mistaken for a current test's own row. `dish_generation_attempts` has
// no such key to make that trick work — the ceiling counts *all* rows in the
// window, not a lookup by key — so it is the one table that actually needs
// resetting.
export default async function setup(): Promise<void> {
  if (!(await isLocalStackAvailable())) return;

  const admin = bypassClient();
  try {
    await admin`delete from dish_generation_attempts`;
  } finally {
    await admin.end({ timeout: 5 });
  }
}
