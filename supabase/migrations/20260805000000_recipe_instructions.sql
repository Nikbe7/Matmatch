-- Tier 1 cooking-instructions cache (issue #78, ARCHITECTURE.md §4.2 caching rule).
--
-- Not household data: no user id column, no household_id, and this migration does
-- NOT enable row level security on this table at all — no `enable row level
-- security`, no policies. That is deliberate, not an oversight; see DECISION_LOG
-- 2026-08-05 for the reasoning. The 2026-08-03 "least-privilege role" entry's
-- grant/TO-clause trap (missing the role in a policy's TO clause reads as zero rows,
-- silently, forever) only applies where a policy exists to be missed from — there is
-- no policy here, so the only thing this table needs is the explicit GRANT below.
-- The Data API stays disabled project-wide (DECISION_LOG 2026-08-02), so there is no
-- client-reachable path to this table regardless.

create table public.recipe_instructions (
  id uuid primary key default gen_random_uuid(),
  -- References data/recipe-templates.json, not a database table — recipe templates
  -- are curated JSON, loaded by src/engine/data.ts (DECISION_LOG 2026-08-02,
  -- condition 4), so there is deliberately no FK here.
  template_id text not null,
  -- Sorted "slot_index:substitute_ingredient_id" pairs, one per substituted slot —
  -- keyed on slot index, not only the substitute ingredient id (DECISION_LOG
  -- 2026-08-05), so two different slots swapped to the same ingredient never
  -- collide on this key. Canonical sorting/formatting is owned entirely by
  -- src/db/recipeInstructions.ts, applied identically before every read and write,
  -- so equality here is a plain array compare — the database does no
  -- canonicalization of its own.
  substitution_key text[] not null default '{}',
  steps jsonb not null,
  created_at timestamptz not null default now(),
  constraint recipe_instructions_unique_key unique (template_id, substitution_key)
);

comment on table public.recipe_instructions is
  'Tier 1 cooking-instructions cache, keyed by template + substitution set. Deliberately not RLS-protected: not household data, no user context in the row — see DECISION_LOG 2026-08-05.';

create index recipe_instructions_template_id_idx on public.recipe_instructions (template_id);

grant select, insert, update, delete on public.recipe_instructions to matmatch_app;
