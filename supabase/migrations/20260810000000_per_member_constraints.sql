-- Allergies and dietary flags move from the household onto its members (#115).
--
-- Reverses the original ARCHITECTURE.md §5 line "shared across the household, not
-- per-member" — see DECISION_LOG 2026-08-09. A household does not have allergies;
-- people do. Storing only the union discards whose allergy it is, which is the fact
-- diner-scoped constraints (#112) need and which no downstream query can recover.
--
-- The household-level columns are DROPPED here rather than kept in sync: two stores
-- of the same safety-critical fact is exactly the drift ARCHITECTURE.md §5.3/§5.5
-- forbid for allergen data. The effective household constraint set is derived at
-- read time instead (src/engine/constraints.ts).
--
-- Behavior-preserving by construction: every member is backfilled with its
-- household's arrays, so the union over all members equals the old household value
-- for every existing row. Nothing is deployed yet (DECISION_LOG 2026-08-07 — the Fly
-- app was never created), so this rewrites development data only.

alter table public.household_members
  add column allergies public.allergy_value[] not null default '{}',
  add column dietary_flags public.dietary_flag_value[] not null default '{}';

update public.household_members m
   set allergies = h.allergies,
       dietary_flags = h.dietary_flags
  from public.households h
 where h.id = m.household_id;

-- The defaults existed only so ADD COLUMN could populate existing rows; they are
-- dropped now so storage agrees with HouseholdMemberSchema, where both arrays are
-- required with no default. An INSERT that omits them must error rather than quietly
-- record "this person has no allergies" — the §5.4 reasoning for making
-- verification_status required, applied one level down.
alter table public.household_members
  alter column allergies drop default,
  alter column dietary_flags drop default,
  add constraint household_members_allergies_no_duplicates
    check (public.array_has_no_duplicates(allergies)),
  add constraint household_members_dietary_flags_no_duplicates
    check (public.array_has_no_duplicates(dietary_flags));

-- Optional first name or nickname, so the #112 diner picker can say "Ella" rather
-- than "Barn 2". Nullable and blank-normalised to NULL by the schema — a household
-- never has to name anyone. Length bounded to match MEMBER_NAME_MAX_LENGTH.
alter table public.household_members
  add column name text
    check (name is null or (length(name) > 0 and length(name) <= 40));

alter table public.households
  drop constraint households_allergies_no_duplicates,
  drop constraint households_dietary_flags_no_duplicates,
  drop column allergies,
  drop column dietary_flags;

comment on table public.households is
  'Household ownership anchor. Constraints live on household_members; the household''s effective set is derived, never stored.';

comment on table public.household_members is
  'A person in a household. allergies[] and name are sensitive personal data under GDPR (ARCHITECTURE.md §7), and members may be children.';

-- Row Level Security and grants ----------------------------------------------
--
-- Nothing to add. RLS is already ENABLEd and FORCEd on public.household_members, and
-- both grants covering it (authenticated, matmatch_app) are table-wide rather than
-- column-scoped — see 20260803000000_households.sql and
-- 20260803120000_least_privilege_app_role.sql — so the columns added above are
-- covered without a new GRANT.
--
-- Per DECISION_LOG 2026-08-07 that is NOT taken on trust: "what the migration does
-- not say is exactly what varies between the local stack and the hosted project."
-- src/db/rls.test.ts asserts relrowsecurity/relforcerowsecurity and reads the new
-- columns as matmatch_app against the real stack, so a silent privilege gap fails a
-- test rather than surfacing as an empty result set in production.
--
-- public.households keeps its own RLS and policies unchanged: they key on
-- owner_user_id, which this migration does not touch, and the member policies are
-- defined by reference to it — which is why the table is kept rather than collapsed
-- once its last profile column is gone.
