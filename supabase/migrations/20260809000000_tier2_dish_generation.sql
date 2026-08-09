-- Tier 2 on-demand dish generation (issue #113, DECISION_LOG 2026-08-09 "Tier 2
-- generation: exact-match resolution, household-free cache key, unverified-content
-- rule"). Three tables, none holding household data or a per-row owner — same
-- rationale as recipe_instructions (DECISION_LOG 2026-08-05): RLS is a mechanism for
-- scoping rows to the household that owns them, and none of these rows have one.
--
-- Explicitly `disable row level security` on every table below, in this same
-- migration, rather than relying on the local stack's "off by default" — issue #99
-- (migration 20260807000000_recipe_instructions_disable_rls.sql) found that a
-- hosted Supabase project enables RLS on new `public` tables automatically, which
-- silently denies every read/write to `matmatch_app` (no rolbypassrls) while every
-- local test stays green. Getting this right the first time here, rather than as a
-- follow-up migration, is the whole point of that lesson.
--
-- The Data API (PostgREST) is disabled project-wide (DECISION_LOG 2026-08-02), so
-- none of these tables have a client-reachable path regardless — the Node backend is
-- the only reader/writer, same as recipe_instructions.

-- Generated-dish cache: the model's validated raw output (GeneratedDishOutput), never
-- a resolved-and-safety-checked result. Keyed on generator_version + a normalized
-- query phrase, with no household data in the key — safe because no household data
-- ever reaches generation in the first place (src/ai/dishPrompt.ts sends only the
-- query and the catalog's ingredient names). Every read re-runs resolution and the
-- allergy gate against the cached output (src/engine/generatedDish.ts), so a cache
-- hit can never itself change the applicable allergy outcome for the household
-- reading it.
create table public.generated_dishes (
  id uuid primary key default gen_random_uuid(),
  -- Bumped whenever the prompt, output schema, or resolution algorithm changes, so a
  -- row produced under old rules is never reused under new ones — see
  -- src/db/generatedDishes.ts's GENERATOR_VERSION constant, the single place this
  -- value is chosen.
  generator_version smallint not null,
  -- NFC-normalized, lowercased, whitespace-collapsed, trailing-punctuation-stripped
  -- query phrase. Canonicalization is owned entirely by
  -- src/db/generatedDishes.ts's buildQueryKey, applied identically before every read
  -- and write, so equality here is a plain text compare.
  query_key text not null,
  output jsonb not null,
  created_at timestamptz not null default now(),
  constraint generated_dishes_unique_key unique (generator_version, query_key)
);

comment on table public.generated_dishes is
  'Tier 2 dish-generation cache, keyed by generator version + normalized query phrase. No household data in the key or the row — see DECISION_LOG 2026-08-09.';

alter table public.generated_dishes disable row level security;

grant select, insert on public.generated_dishes to matmatch_app;

-- Unresolved-ingredient review queue (issue #113 requirement 6): a simple table, no
-- admin UI in this slice, so unresolved proposed names accumulate into something a
-- human can later turn into curated catalog rows. Deduplicated by proposed_name with
-- a running seen_count, rather than one row per occurrence, so a name that keeps
-- coming up is visibly more urgent than one seen once.
create table public.ingredient_review_queue (
  id uuid primary key default gen_random_uuid(),
  proposed_name text not null,
  -- Free text, not a domain type: this table is intentionally decoupled from the
  -- curated ingredient_slot role vocabulary (data/*.json, validated only by
  -- src/schema/recipeTemplate.ts's IngredientSlotRoleSchema) — the review queue's
  -- job is to record what the model actually said, even if that vocabulary ever
  -- changes shape, not to be the thing that would break if it did.
  role text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  seen_count integer not null default 1,
  constraint ingredient_review_queue_unique_name unique (proposed_name)
);

comment on table public.ingredient_review_queue is
  'Unresolved Tier 2 ingredient names, for eventual curated review — see DECISION_LOG 2026-08-09. No admin UI in this slice.';

alter table public.ingredient_review_queue disable row level security;

grant select, insert, update on public.ingredient_review_queue to matmatch_app;

-- Global daily generation ceiling (DECISION_LOG 2026-08-05: "Tier 2 ships with a
-- per-user monthly cap and a global spend ceiling, or it doesn't ship — neither is
-- optional"). One row per real Anthropic API call attempted for Tier 2 (recorded
-- before the call, not after — see src/db/generatedDishes.ts's
-- recordGenerationAttempt), so the count reflects money that could be spent, not
-- just successful generations. The per-user monthly cap is a separate,
-- out-of-scope freemium-gating slice (issue #113's "Out of scope").
create table public.dish_generation_attempts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

comment on table public.dish_generation_attempts is
  'One row per attempted Tier 2 generation call, for the global daily spend ceiling — see DECISION_LOG 2026-08-09.';

create index dish_generation_attempts_created_at_idx on public.dish_generation_attempts (created_at);

alter table public.dish_generation_attempts disable row level security;

grant select, insert on public.dish_generation_attempts to matmatch_app;
