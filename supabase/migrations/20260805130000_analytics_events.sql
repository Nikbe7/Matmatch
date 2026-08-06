-- Frontend analytics ingest (issue #91): the real destination for the typed events
-- web/src/analytics.ts already emits but, until now, only logged in dev mode.
--
-- Household data, same as cooked_meals (20260805120000): every row belongs to
-- exactly one household, so it gets the full RLS treatment, and the 2026-08-03
-- grant/TO-clause trap applies here in full. See the ⚠ header in
-- 20260803120000_least_privilege_app_role.sql: both the GRANT below and
-- `matmatch_app` in every policy's TO clause are required, and missing the second
-- one reads as zero rows forever rather than as an error.
--
-- No event-name check constraint here: the closed vocabulary is enforced at the API
-- boundary (src/api/routes/analytics.ts's zod schema, mirroring
-- web/src/analytics.ts's AnalyticsEvent union), the same layer that already owns
-- rejecting an unrecognised event outright. A DB-level enum would duplicate that
-- vocabulary in a second place that needs its own migration to extend — exactly the
-- allergy_value/dietary_flag_value domain pattern this table deliberately does not
-- repeat, since nothing downstream of this table trusts event_name without going
-- through the API first.

create table public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  event_name text not null,
  -- The event's fields minus `name` (which is event_name above) — whatever shape
  -- the matching branch of web/src/analytics.ts's AnalyticsEvent union declares,
  -- already validated against the server-side mirror before this table ever sees
  -- it. No free text, no ingredient names, no user input of any kind (issue #91).
  payload jsonb not null default '{}',
  -- When the client observed the event, distinct from server_timestamp below: a
  -- flush can lag the tap by up to the sink's flush interval (web/src/analyticsSink.ts),
  -- and a burst of buffered events flushed together would otherwise all read as
  -- having happened at once.
  client_timestamp timestamptz not null,
  server_timestamp timestamptz not null default now()
);

comment on table public.analytics_events is
  'Frontend analytics events per household (issue #91). Append-only, RLS-protected, closed vocabulary enforced at the API layer.';

-- Serves the only read there is for now: this household's events in server-arrival
-- order. No dashboard or reporting endpoint exists yet (out of scope for #91) — the
-- only reader today is a psql query.
create index analytics_events_household_server_timestamp_idx
  on public.analytics_events (household_id, server_timestamp desc);

-- Row Level Security ---------------------------------------------------------
--
-- Same shape as cooked_meals: ownership inherited through household_id, FORCE so
-- the table owner cannot silently bypass the policies below.

alter table public.analytics_events enable row level security;
alter table public.analytics_events force row level security;

revoke all on public.analytics_events from anon;

-- SELECT and INSERT only, no UPDATE or DELETE — for either role, same rationale as
-- cooked_meals: history is append-only, and a bug cannot quietly rewrite or erase it.
-- Adding either capability later needs BOTH a grant here and a matching policy — a
-- grant alone matches no policy and reads as zero affected rows.
--
-- Deleting a household still removes its events: the FK's ON DELETE CASCADE runs as
-- the table owner and is not subject to the app role's privileges or to RLS, so no
-- delete grant is needed for it.
grant select, insert on public.analytics_events to authenticated;
grant select, insert on public.analytics_events to matmatch_app;

create policy analytics_events_owner_select on public.analytics_events
  for select to authenticated, matmatch_app
  using (
    exists (
      select 1 from public.households h
      where h.id = analytics_events.household_id
        and h.owner_user_id = (select auth.uid())
    )
  );

create policy analytics_events_owner_insert on public.analytics_events
  for insert to authenticated, matmatch_app
  with check (
    exists (
      select 1 from public.households h
      where h.id = analytics_events.household_id
        and h.owner_user_id = (select auth.uid())
    )
  );
