-- Household profiles — the first persisted entity (issue #52).
--
-- Mirrors HouseholdSchema / HouseholdMemberSchema in src/schema/household.ts
-- field-for-field. The persistence-only columns (id, owner_user_id, created_at,
-- updated_at) exist at the table level only: the in-memory type stays free of them
-- deliberately, per its own doc comment, so the Meal Engine keeps taking a plain
-- household profile rather than a database row.
--
-- Access model (DECISION_LOG 2026-08-02, condition 2): the Node backend is the only
-- path to this data. The project's Data API (PostgREST) is disabled, so there is no
-- client-facing REST surface at all. The RLS policies below are defense-in-depth
-- against direct database access — they are NOT the mechanism the backend relies on
-- for authorization.

-- Vocabulary lists are duplicated from ARCHITECTURE.md §5.2 rather than referencing
-- an enum type, so that adding a value is a reviewed migration and not a silent
-- widening. Kept in sync with src/schema/allergyDietary.ts by the test suite.
create domain public.allergy_value as text
  check (value in (
    'gluten', 'dairy_lactose', 'egg', 'tree_nuts', 'peanuts', 'shellfish', 'fish', 'soy'
  ));

create domain public.dietary_flag_value as text
  check (value in ('vegetarian', 'vegan', 'high_protein_preference'));

-- CHECK constraints cannot contain subqueries, so the no-duplicates rule that
-- HouseholdSchema expresses as a zod refinement needs an immutable helper.
-- Parameter is `elements`, not `values`: VALUES is a reserved word and cannot be a
-- parameter name here.
create or replace function public.array_has_no_duplicates(elements anyarray)
returns boolean
language sql
immutable
strict
parallel safe
as $$
  select cardinality(elements) = (select count(distinct elem) from unnest(elements) as elem);
$$;

create table public.households (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  allergies public.allergy_value[] not null default '{}',
  dietary_flags public.dietary_flag_value[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint households_allergies_no_duplicates
    check (public.array_has_no_duplicates(allergies)),
  constraint households_dietary_flags_no_duplicates
    check (public.array_has_no_duplicates(dietary_flags))
);

comment on table public.households is
  'Household profile. allergies[] is sensitive personal data under GDPR (ARCHITECTURE.md §7).';

create index households_owner_user_id_idx on public.households (owner_user_id);

create table public.household_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  type text not null check (type in ('adult', 'child')),
  -- double precision, not numeric: postgres.js returns numeric as a string to avoid
  -- precision loss, and portion_factor is a plain JS number in HouseholdMemberSchema.
  -- float8 round-trips through JS exactly, so the repository needs no cast or coercion.
  portion_factor double precision not null
    check (portion_factor > 0 and portion_factor <= 10),
  -- Members are an ordered array in HouseholdSchema; rows are not ordered, so the
  -- authored position is stored explicitly rather than relying on insertion order.
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  constraint household_members_unique_position unique (household_id, position)
);

create index household_members_household_id_idx on public.household_members (household_id);

-- HouseholdSchema requires at least one member. That is a cross-row invariant, so it
-- is enforced by the repository (which writes a household and its members in one
-- transaction) and re-checked by zod on read, not by a table constraint.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger households_set_updated_at
  before update on public.households
  for each row
  execute function public.set_updated_at();

-- Row Level Security ---------------------------------------------------------
--
-- FORCE, not just ENABLE: without FORCE, the table owner bypasses every policy
-- below, which would make these policies silently inert for any connection that
-- happens to own the tables. Note that a superuser (e.g. the default local
-- `postgres` role) still bypasses RLS entirely — see README and the DECISION_LOG
-- entry for what that means and what it does not protect against.

alter table public.households enable row level security;
alter table public.households force row level security;
alter table public.household_members enable row level security;
alter table public.household_members force row level security;

-- Explicit grants so that RLS is demonstrably the thing denying access in the tests,
-- rather than a missing privilege. anon gets nothing: an unauthenticated caller has
-- no business reading household or allergy data under any policy.
revoke all on public.households from anon;
revoke all on public.household_members from anon;
grant select, insert, update, delete on public.households to authenticated;
grant select, insert, update, delete on public.household_members to authenticated;

create policy households_owner_select on public.households
  for select to authenticated
  using (owner_user_id = (select auth.uid()));

create policy households_owner_insert on public.households
  for insert to authenticated
  with check (owner_user_id = (select auth.uid()));

create policy households_owner_update on public.households
  for update to authenticated
  using (owner_user_id = (select auth.uid()))
  with check (owner_user_id = (select auth.uid()));

create policy households_owner_delete on public.households
  for delete to authenticated
  using (owner_user_id = (select auth.uid()));

-- Members inherit their household's ownership rather than carrying a duplicate
-- owner_user_id column, which would be a second source of truth for the same fact.
create policy household_members_owner_select on public.household_members
  for select to authenticated
  using (
    exists (
      select 1 from public.households h
      where h.id = household_members.household_id
        and h.owner_user_id = (select auth.uid())
    )
  );

create policy household_members_owner_insert on public.household_members
  for insert to authenticated
  with check (
    exists (
      select 1 from public.households h
      where h.id = household_members.household_id
        and h.owner_user_id = (select auth.uid())
    )
  );

create policy household_members_owner_update on public.household_members
  for update to authenticated
  using (
    exists (
      select 1 from public.households h
      where h.id = household_members.household_id
        and h.owner_user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.households h
      where h.id = household_members.household_id
        and h.owner_user_id = (select auth.uid())
    )
  );

create policy household_members_owner_delete on public.household_members
  for delete to authenticated
  using (
    exists (
      select 1 from public.households h
      where h.id = household_members.household_id
        and h.owner_user_id = (select auth.uid())
    )
  );
