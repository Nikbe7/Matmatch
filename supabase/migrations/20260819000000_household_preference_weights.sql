-- The household's persistent preference baseline: price, time, variation, simplicity
-- (issue #157, DECISION_LOG 2026-08-16 "Preference sliders introduced on Tonight and
-- the profile").
--
-- Mirrors PreferenceWeightsSchema in src/schema/preferenceWeights.ts field for field.
-- That module is the single axis definition: the persistent baseline stored here and
-- the session-scoped chip delta (never persisted, DECISION_LOG 2026-07-31 as amended)
-- are values of the same type, differing only in lifetime. Two axis definitions would
-- let the Pris slider and the "Billigare" chip disagree about what the household asked
-- for, which is the whole failure mode this schema exists to prevent.
--
-- These columns affect RANKING ONLY. Allergy and dietary exclusion is decided by
-- src/engine/candidates.ts, which is never handed a weight vector at all — so no value
-- writable here can widen what a household is shown. That is a structural property, not
-- a convention, and src/engine/preferenceWeights.test.ts asserts it exhaustively across
-- all eight allergy categories.

-- Four constrained scalar columns rather than one jsonb blob. The acceptance criterion
-- for #157 is that an out-of-range weight is rejected by the *schema*, not merely by a
-- UI that does not exist yet; jsonb would push every one of these checks up into
-- application code and leave the database accepting `{"price": 4000}`. A domain, in
-- turn, rather than four repeated CHECK clauses, so the range is stated once — the same
-- reasoning as public.allergy_value.
--
-- Step of 5 is enforced here as well as in zod: the value is a stated preference read
-- off a coarse control, and a stray 37 in the table would be a value no human could
-- have meant, i.e. evidence of a bug rather than a preference.
create domain public.preference_weight as integer
  check (value >= 0 and value <= 100 and value % 5 = 0);

-- Defaults are KEPT after the backfill, unlike the arrays in
-- 20260810000000_per_member_constraints.sql which dropped theirs. The difference is
-- what an omitted value means. An omitted allergy list is an *unset* safety value that
-- must never be mistaken for a declared empty one, so it has to error. An omitted
-- weight is a household that has expressed no preference — a real, expected, and by far
-- the most common state — and 0 ("Spelar liten roll") says exactly that.
--
-- 0 on every axis is also what makes this migration behaviour-preserving by
-- construction rather than by measurement: toRankingWeights maps each axis's zero onto
-- the constant src/engine/ranking.ts scored with before #157 (price 0, time 0,
-- familiarity 1.5). No existing row can therefore land in a state where its ranking
-- differs from what it was yesterday. src/engine/preferenceWeights.test.ts proves that
-- over the whole template library rather than on a sample.
alter table public.households
  add column preference_price public.preference_weight not null default 0,
  add column preference_time public.preference_weight not null default 0,
  add column preference_variation public.preference_weight not null default 0,
  -- Stored but inert, and NOT rendered: there is no curated effort signal on
  -- recipe_templates yet (#151 is the data pass that creates one), so this axis cannot
  -- change a ranking decision. It is persisted now only so #153's "Enklare" chip lands
  -- on an axis that already exists instead of inventing a parallel mechanic. Do not add
  -- the fourth slider until #151 lands — see the field comment in
  -- src/schema/preferenceWeights.ts for why a control with no consequence is worse than
  -- a missing one.
  add column preference_simplicity public.preference_weight not null default 0;

comment on column public.households.preference_simplicity is
  'Stored but inert until #151 supplies a curated effort signal. Must not be rendered as a slider while it changes nothing.';

comment on table public.households is
  'Household ownership anchor plus the persistent preference baseline (#157). Constraints live on household_members; the household''s effective set is derived, never stored.';

-- Row Level Security and grants ----------------------------------------------
--
-- Nothing to add, and that is a claim this migration is not allowed to make on trust
-- (DECISION_LOG 2026-08-07: "what the migration does not say is exactly what varies
-- between the local stack and the hosted project").
--
-- The reasoning: public.households already has RLS ENABLEd and FORCEd, and its four
-- owner-scoped policies key on owner_user_id — a column this migration does not touch —
-- so an added column is covered by the existing predicates without a new policy. Both
-- grants covering the table (authenticated, matmatch_app) are table-wide rather than
-- column-scoped, so no new GRANT is needed either. See 20260803000000_households.sql and
-- 20260803120000_least_privilege_app_role.sql.
--
-- src/db/rls.test.ts asserts that against the real stack for these specific columns, in
-- both directions: a user cannot READ another household's weights through an unfiltered
-- query, and cannot WRITE them through a targeted UPDATE. A silent privilege gap fails a
-- test rather than surfacing later as one household editing another's preferences.
