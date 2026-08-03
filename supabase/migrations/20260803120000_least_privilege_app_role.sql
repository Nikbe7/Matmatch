-- Least-privilege application role (issue #53).
--
-- Before this migration the backend connected as `postgres`, which carries
-- rolbypassrls — not superuser, but the same practical effect: RLS never applied to
-- backend queries, so the policies added with the households tables were inert
-- against a bug in our own SQL. This migration gives the application its own role,
-- which has no bypass, so a repository query that forgets an owner filter returns
-- nothing instead of another household's rows.
--
-- Authorization is still the backend's job (DECISION_LOG 2026-08-02, condition 2:
-- the backend is the only path to this data). RLS is the second line underneath it —
-- but from here on it is a real one.
--
--
-- ⚠ ADDING A NEW TABLE? READ THIS. ⚠
--
-- This migration deliberately does NOT use ALTER DEFAULT PRIVILEGES, so a table
-- created later grants matmatch_app nothing. Every new table holding application
-- data needs BOTH of the following in its own migration, or the backend breaks in
-- the slowest possible way to diagnose:
--
--   1. grant select, insert, update, delete on <table> to matmatch_app;
--   2. the role listed in each policy's TO clause:
--        create policy ... on <table> for select to authenticated, matmatch_app ...
--
-- Miss (1) and you get "permission denied" — loud, easy. Miss (2) and RLS matches no
-- policy for the role, which is not an error: the backend simply reads ZERO ROWS,
-- forever, silently. That silence is why this warning is here and in README.md.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'matmatch_app') then
    -- No password here on purpose. A password in a committed migration is a
    -- credential that `supabase db push` would install in the cloud project. The
    -- role therefore cannot authenticate until a password is set per environment:
    -- supabase/seed.sql does it locally (never pushed), and the cloud project gets
    -- its own via the dashboard SQL editor. A missing password fails closed —
    -- the backend cannot connect at all.
    create role matmatch_app with
      login
      nosuperuser
      nobypassrls
      nocreatedb
      nocreaterole
      noreplication
      inherit;
  else
    -- Idempotent: re-running must not weaken the attributes of an existing role.
    alter role matmatch_app with
      login nosuperuser nobypassrls nocreatedb nocreaterole noreplication inherit;
  end if;
end
$$;

comment on role matmatch_app is
  'Application connection role. No RLS bypass — household scoping is enforced by policy.';

grant connect on database postgres to matmatch_app;

-- USAGE only. No CREATE: the application must not be able to add, drop or alter
-- objects in the schema it reads from.
grant usage on schema public to matmatch_app;

grant select, insert, update, delete on public.households to matmatch_app;
grant select, insert, update, delete on public.household_members to matmatch_app;

-- Sequences: none to grant. Both tables key on uuid defaults rather than serial, so
-- the role needs no sequence privileges; adding a serial column later would need an
-- explicit grant here, same as the tables above.

-- Note what is deliberately NOT granted: no usage on schema `auth`. The role
-- therefore cannot call auth.uid() directly or read auth.users, yet the policies
-- below — which reference auth.uid() — still evaluate correctly for it, because a
-- policy expression is not subject to the caller's schema privileges. Verified
-- against the local stack; pinned by a test in src/db/rls.test.ts so that if this
-- ever changes it fails loudly (permission denied) rather than silently.

-- Policies currently name only `authenticated`, and a role that matches no policy is
-- denied everything. Adding matmatch_app to the TO clause is what makes the existing
-- rules apply to the backend's connection. The USING / WITH CHECK predicates are
-- untouched: this changes who the rules cover, not what they say.
alter policy households_owner_select on public.households to authenticated, matmatch_app;
alter policy households_owner_insert on public.households to authenticated, matmatch_app;
alter policy households_owner_update on public.households to authenticated, matmatch_app;
alter policy households_owner_delete on public.households to authenticated, matmatch_app;

alter policy household_members_owner_select on public.household_members
  to authenticated, matmatch_app;
alter policy household_members_owner_insert on public.household_members
  to authenticated, matmatch_app;
alter policy household_members_owner_update on public.household_members
  to authenticated, matmatch_app;
alter policy household_members_owner_delete on public.household_members
  to authenticated, matmatch_app;
