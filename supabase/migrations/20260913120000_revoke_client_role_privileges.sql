-- Client roles lose TRUNCATE (and the rest of the bootstrap grant) on public (#267).
--
-- Supabase's bootstrap hands `anon`, `authenticated` and `service_role` a standing set
-- of privileges on the public schema. Observed on a clean stack before this migration,
-- on every table: TRUNCATE, REFERENCES, TRIGGER and MAINTAIN — and UPDATE on every
-- sequence, which for a sequence means `setval`.
--
-- ⚠ TRUNCATE IS NOT SUBJECT TO ROW LEVEL SECURITY. ⚠
--
-- That is what makes this worth a migration rather than a tidy-up. Policies do not see
-- it, so every append-only guarantee in this schema was quietly scoped to DELETE and did
-- not cover it. 20260805130000_analytics_events.sql states the promise plainly —
-- "SELECT and INSERT only, no UPDATE or DELETE … history is append-only, and a bug
-- cannot quietly rewrite or erase it" — and cooked_meals says the same. One
-- `truncate analytics_events` as `authenticated` erased every household's history, with
-- no policy in the way and no row scoping to hold it to the caller's own rows.
--
-- The sequence grant is the sharper edge, because it undoes a guarantee added the day
-- before. `analytics_events.seq` (#98) is what gives that table a read order, and the
-- unique index on (household_id, seq desc) is what makes the order total. `w` on the
-- backing sequence is `setval` — so any caller holding it could wind the sequence back
-- and either reintroduce the ties #98 removed or, with the unique index in place, break
-- the analytics write path outright. Nothing needed that privilege; it arrived with the
-- sequence, automatically, from the default privileges below.
--
-- None of this was reachable: PostgREST exposes no TRUNCATE verb, the backend connects
-- as `matmatch_app` (which correctly holds none of these), and no SECURITY DEFINER or
-- dynamic-SQL function exists to reach them through. It is fixed now because the first
-- RPC added would make a documented guarantee false, and because the fix is a revoke.
--
-- Revoke-all-then-re-grant rather than naming the privileges to drop. Naming them means
-- keeping a list in sync with whatever a future Postgres adds to "all" — MAINTAIN is
-- exactly that, new in 17 and already in the bootstrap set. Deny by default, grant the
-- intent explicitly, and the list that needs maintaining is the one we wrote.

revoke all on all tables in schema public from anon, authenticated, service_role;
revoke all on all sequences in schema public from anon, authenticated, service_role;

-- Re-granted verbatim from the migration that first asked for it, so this migration
-- changes what was never intended and nothing that was. The four tables not listed
-- (dish_generation_attempts, generated_dishes, ingredient_review_queue,
-- recipe_instructions) never granted a client role anything: they are backend-owned and
-- reached only through matmatch_app, whose privileges this migration does not touch.
grant select, insert, update, delete on public.households to authenticated;         -- 20260803000000
grant select, insert, update, delete on public.household_members to authenticated;  -- 20260803000000
grant select, insert on public.cooked_meals to authenticated;                       -- 20260805120000
grant select, insert on public.analytics_events to authenticated;                   -- 20260805130000

-- `service_role` is narrowed to nothing, which #267 asked to have decided rather than
-- assumed. It held only the bootstrap set — no SELECT, no INSERT, nothing the schema
-- ever granted it — and nothing in this project authenticates as it: the service-role
-- key is issued by Supabase but never used, and .env.example says so outright ("no
-- signing key or service-role key belongs in this file"). A role nothing uses holding
-- TRUNCATE on every table is the exact shape of privilege that matters only once a key
-- leaks. If an Edge Function or an admin script ever needs it, it fails loudly with
-- permission denied and gets an explicit grant here — the recoverable direction.

-- ⚠ AND THE PART THAT MAKES IT STICK ⚠
--
-- The revokes above only cover tables that exist today. The grants come from ALTER
-- DEFAULT PRIVILEGES, so without the three statements below every table and sequence
-- added after this migration would arrive with the bootstrap set intact and this fix
-- would read as a one-off cleanup that silently stopped applying.
--
-- `for role postgres` is named rather than left implicit, and the role matters: a
-- default-privileges entry is per granting role (pg_default_acl.defaclrole) and applies
-- to objects *that role creates*. Schema public carries two entries per object type —
-- one from `supabase_admin`, one from `postgres`. Migrations run as `postgres` (checked,
-- not assumed: `select current_user` during a migration returns postgres), so the
-- postgres entry is the one governing every table this project adds, and it is the one
-- revoked here. The supabase_admin entry is deliberately left alone: it governs objects
-- supabase_admin itself creates, which are Supabase's own and not ours to re-privilege,
-- and rewriting another role's defaults to cover a case that does not arise would be a
-- change with a blast radius well outside this schema.
--
-- Verified after applying: a table and a sequence created as postgres in public both
-- come out with a null ACL — owner only, no client-role grants at all.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated, service_role;
