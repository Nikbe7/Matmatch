-- A read order for analytics_events that exists and matches write order (#98).
--
-- `server_timestamp` is `default now()`, and `now()` is transaction start time, not
-- per-statement time — so every row written by one `recordAnalyticsEvents` call carries
-- the *same* server_timestamp (src/db/analyticsEvents.ts sends the batch as a single
-- multi-row insert, deliberately, so the batch is all-or-nothing). `order by
-- server_timestamp` therefore leaves those rows tied, and a tie is not an order:
-- Postgres returns them in whatever physical or plan order it likes, which is why #103
-- saw the same two rows swap between runs with no code change in between.
--
-- #103 closed by deleting the test's order assertion rather than fixing the order, on
-- the explicit condition that a real reader did not exist yet. It does now: #255 began
-- recording `main_search_miss`, and reading that log means reading a household's queries
-- *in sequence* — whether "rotfrukt" was abandoned or refined into "rotfrukter" is the
-- whole signal, and it is only visible in the order.
--
-- `seq` is that order: one bigint per row from a sequence, taken as each row is formed,
-- so it follows the order rows were actually written — within a batch and across
-- batches alike. `generated always as identity` rather than a plain default, so the
-- application cannot supply a value and cannot disagree with it; src/db/analyticsEvents.ts
-- never names the column and needs no change.
--
-- Read this table `order by seq`, and NOT `order by server_timestamp, seq`. The
-- composite key is deterministic but wrong: it sorts on transaction *start*, so two
-- overlapping flushes come back inverted — the transaction that began first but wrote
-- second sorts first. Measured on this stack, not reasoned about: with A starting 100ms
-- before B and writing 300ms after it, `order by server_timestamp, seq` returned A then
-- B while `order by seq` returned B then A, which is the order the rows were written.
-- `seq` alone is already unique, so nothing is traded away for dropping the timestamp
-- out of the sort key — server_timestamp stays a recorded fact, just not the order.
--
-- Not `clock_timestamp()` as the server_timestamp default instead: it would make ties
-- rare without ruling them out (two rows of one batch can land inside the same
-- microsecond), and "usually distinct" is the property this table already had.
-- Not `id`: it is a uuid v4, so ordering by it is ordering by randomness.
-- Not `client_timestamp`: client-supplied, and untrusted for ordering.
--
-- Lock and rewrite: adding an identity column rewrites the table and the index swap is
-- non-concurrent, so both take ACCESS EXCLUSIVE. Acceptable here and worth stating —
-- nothing is deployed, and the table holds test rows only. Existing rows get backfilled
-- in the order the rewrite reads the heap; on an append-only table with no UPDATE or
-- DELETE that is effectively insert order, but it is not promised, and no reader has
-- drawn a conclusion from the order of those rows yet.

alter table public.analytics_events
  add column seq bigint generated always as identity;

comment on column public.analytics_events.seq is
  'Write order within the table (#98). Read this table `order by seq` — not by server_timestamp, which is transaction start time and so both ties within a batch and inverts across overlapping ones. Monotonic, not gapless: the sequence is shared, so a concurrent writer takes values out of the middle. Values for rows predating this column reflect table-rewrite order.';

-- Replaces #91's (household_id, server_timestamp desc) index rather than joining it.
-- That index existed for one read — "this household's events in server-arrival order"
-- (its own comment) — and `seq desc` is that order, more precisely than the column it
-- was built on. Nothing is left unindexed that was indexed before.
--
-- UNIQUE, because the determinism argument rests on the sort key holding a distinct
-- value per row and an identity column alone does not promise that — `alter sequence
-- ... restart` would quietly reintroduce the ties this migration exists to remove. The
-- constraint is per household because that is the scope every read filters to, and it
-- costs nothing extra: this is the same index the ordered read already needs.
drop index public.analytics_events_household_server_timestamp_idx;

create unique index analytics_events_household_seq_idx
  on public.analytics_events (household_id, seq desc);
