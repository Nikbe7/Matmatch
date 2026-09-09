-- Corrects table comments that still describe allergies[] as held personal data
-- (#241). #224 removed allergy filtering from the product; since then the column
-- has been dormant, written only as an empty list (src/db/households.ts) and read
-- by nothing. The comments below predate that change and were never updated,
-- leaving them contradicting ARCHITECTURE.md §7 ("unwritten with any value and
-- unread ... holds only empty lists").
--
-- The column itself is untouched: it stays for now so its removal can be reverted
-- with `git revert` rather than a down migration (DECISION_LOG 2026-08-25), and it
-- remains `not null` with no default so "nobody wrote an allergy list" can never be
-- silently recorded as "no allergies". Comments only, applied forward.

comment on table public.household_members is
  'A person in a household, possibly a child. name is sensitive personal data under GDPR (ARCHITECTURE.md §7). The allergies[] column is dormant since #224 — kept only so its removal can be reverted, written as empty lists, read by nothing — and holds no personal data.';
