-- Cooked-meal history, the input to Tonight's repeat-avoidance (issue #88).
--
-- This is household data, unlike recipe_instructions (20260805000000): every row
-- belongs to exactly one household, so it gets the full RLS treatment the households
-- tables have — and the 2026-08-03 grant/TO-clause trap applies here in full. See the
-- ⚠ header in 20260803120000_least_privilege_app_role.sql: both the GRANT below and
-- `matmatch_app` in every policy's TO clause are required, and missing the second one
-- reads as zero rows forever rather than as an error.
--
-- Deliberately NOT the conceptual `GeneratedMeal` + `SavedMeal` pair from
-- ARCHITECTURE.md §5: there is no generated_meals table for a saved meal to reference,
-- and Tonight's repeat-avoidance needs exactly one fact — this household cooked this
-- template on this day. §5 has been updated to describe what was actually built.

create table public.cooked_meals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  -- References data/recipe-templates.json, not a database table — recipe templates are
  -- curated JSON loaded by src/engine/data.ts (DECISION_LOG 2026-08-02, condition 4),
  -- so there is deliberately no FK here, same as recipe_instructions.template_id.
  template_id text not null,
  -- The substitution set in effect when the meal was cooked, in exactly the canonical
  -- form src/db/recipeInstructions.ts's buildSubstitutionKey produces (sorted
  -- "slot_index:substitute_ingredient_id" pairs). Reused verbatim rather than
  -- re-encoded: one canonicalization function for the whole codebase, and the
  -- slot-index-scoping rationale from DECISION_LOG 2026-08-05 carries over unchanged.
  -- Recorded because it is free to record here and impossible to reconstruct later;
  -- nothing reads it yet, and ranking deliberately keys on template_id alone.
  substitution_key text[] not null default '{}',
  cooked_at timestamptz not null default now(),
  -- The calendar day `cooked_at` falls on in Swedish local time, carrying the
  -- idempotency constraint below. A stored column with a default, not a generated
  -- column: `(cooked_at at time zone 'Europe/Stockholm')::date` depends on no session
  -- state but is still only STABLE to Postgres, and a generated column (like an index
  -- expression) requires IMMUTABLE. Europe/Stockholm rather than UTC because "which
  -- evening did the household cook this" is a question about their local day, and
  -- Matmatch is Swedish-only for MVP (DECISION_LOG 2026-07-29). A UTC day boundary
  -- would fall at 01:00/02:00 local — inside the evening this table is about.
  cooked_on date not null default (now() at time zone 'Europe/Stockholm')::date,
  -- Idempotency as a constraint rather than a query: two taps of "Lagad ikväll" for
  -- the same dish on the same evening are one row, enforced atomically with
  -- `on conflict do nothing` (src/db/cookedMeals.ts). The rejected alternative was a
  -- read-then-insert against a `cooked_at > now() - interval '2 hours'` window, which
  -- races two concurrent taps and needs an extra round trip to do worse.
  --
  -- substitution_key is deliberately NOT part of this key: a double tap sends the same
  -- substitutions, and including it would let a second tap whose substitutions drifted
  -- insert a duplicate — the exact thing the constraint exists to prevent. It also
  -- means a household that genuinely cooks one dish twice in a day records one row;
  -- Tonight is dinner-only today (src/engine/candidates.ts), so that case does not
  -- exist yet.
  constraint cooked_meals_one_per_household_template_day
    unique (household_id, template_id, cooked_on)
);

comment on table public.cooked_meals is
  'Cooked-meal history per household — the input to Tonight repeat-avoidance (issue #88). Household-scoped, RLS-protected.';

-- Serves the only read there is: this household's recent history, newest first,
-- bounded by the ranking penalty window (src/engine/ranking.ts).
create index cooked_meals_household_cooked_at_idx
  on public.cooked_meals (household_id, cooked_at desc);

-- Row Level Security ---------------------------------------------------------
--
-- Same shape as household_members (20260803000000): ownership is inherited through
-- household_id rather than duplicated as a second owner_user_id column, which would be
-- a second source of truth for the same fact. FORCE for the same reason it is set
-- there — without it the table owner silently bypasses every policy below.

alter table public.cooked_meals enable row level security;
alter table public.cooked_meals force row level security;

revoke all on public.cooked_meals from anon;

-- SELECT and INSERT only, no UPDATE or DELETE — for either role. Editing and deleting
-- cooked entries is out of scope for #88, and history is append-only in every flow
-- that exists: nothing in the application has a reason to rewrite a past evening.
-- Note this is narrower than the households tables on purpose, so a bug cannot quietly
-- erase history. Adding either capability later needs BOTH a grant here and a matching
-- policy — a grant alone matches no policy and reads as zero affected rows.
--
-- Deleting a household still removes its history: the FK's ON DELETE CASCADE is
-- performed as the table owner and is not subject to the app role's privileges or to
-- RLS, so no delete grant is needed for it.
grant select, insert on public.cooked_meals to authenticated;
grant select, insert on public.cooked_meals to matmatch_app;

create policy cooked_meals_owner_select on public.cooked_meals
  for select to authenticated, matmatch_app
  using (
    exists (
      select 1 from public.households h
      where h.id = cooked_meals.household_id
        and h.owner_user_id = (select auth.uid())
    )
  );

create policy cooked_meals_owner_insert on public.cooked_meals
  for insert to authenticated, matmatch_app
  with check (
    exists (
      select 1 from public.households h
      where h.id = cooked_meals.household_id
        and h.owner_user_id = (select auth.uid())
    )
  );
