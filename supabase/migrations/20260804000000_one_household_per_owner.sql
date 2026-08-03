-- One household per owner (issue #56).
--
-- "Multiple households per user" is a Phase 3 premium feature, not built here.
-- Until it exists, a second POST /api/households for the same user must fail rather
-- than silently create a second row nothing in the app can address — an
-- existence-check-then-insert in application code would still race under concurrent
-- requests, so the constraint has to live in the database.
--
-- Named explicitly rather than left as the default `households_owner_user_id_key`:
-- the API's error middleware maps a unique-violation on THIS constraint to 409
-- "household already exists" by inspecting the constraint name, not the bare
-- SQLSTATE 23505 — a blanket code-only mapping would mislabel any other unique
-- constraint added later as a duplicate-household error.
alter table public.households
  add constraint households_one_per_owner unique (owner_user_id);
