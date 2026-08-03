# Matmatch

Mobile-first, AI-powered food planning PWA for Swedish households. See [`CLAUDE.md`](CLAUDE.md) for project conventions and [`docs/`](docs/) for product, UX and architecture.

## Requirements

- Node.js 22+ (developed on 25)
- Docker (for the local Supabase stack) — `docker ps` must run without `sudo`

## Local setup

```bash
npm install
cp .env.example .env      # local defaults work as-is
npx supabase start        # first run pulls ~2 GB of images
npx supabase db reset     # applies supabase/migrations/ to a fresh database
npm test
```

`npx supabase start` prints the local API URL, database URL and keys. Defaults:

| What | Value |
|---|---|
| API (auth, JWKS) | `http://127.0.0.1:54321` |
| Database | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| Studio | `http://127.0.0.1:54323` |

Stop it with `npx supabase stop`. Database tests are skipped automatically when the stack isn't running, so `npm test` works without Docker — it just covers less.

## Running the API

```bash
npm run dev     # tsx watch — restarts on file change
npm start       # one-shot, no watch
```

Reads `DATABASE_URL`, `SUPABASE_JWKS_URL`, `SUPABASE_JWT_ISSUER`/`AUDIENCE`, and `PORT` (default `3000`) from `.env` — same values as above. Loads `data/*.json` into memory once at startup (not per request) and exits if that fails.

`GET /health` needs nothing else and is what a host's health check should hit. Every route under `/api` requires `Authorization: Bearer <token>` — a Supabase-issued access token, verified against `SUPABASE_JWKS_URL`.

**If database tests skip when the stack *is* up**, check the auth gateway: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:54321/auth/v1/.well-known/jwks.json`. A `502` means Kong is holding a stale upstream after `supabase db reset` restarted GoTrue. Fix:

```bash
docker restart supabase_kong_matmatch
```

## Commands

| Command | What it does |
|---|---|
| `npm test` | Vitest, once |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run validate` | Validates `data/*.json` against the locked schemas |
| `npx supabase db reset` | Recreates the local database from `supabase/migrations/` |
| `npx supabase migration new <name>` | Scaffolds a new migration file |

## The Supabase project

One project, **`eu-north-1` (Stockholm)** — fixed at provisioning. Allergy data is sensitive personal data under GDPR ([ARCHITECTURE.md §7](docs/ARCHITECTURE.md)), and a Supabase project's region cannot be changed afterwards; moving it means creating a new project and migrating.

Two settings on it are load-bearing, not defaults:

- **Data API (PostgREST) is disabled**, and "automatically expose new tables" is off. There is no client-facing REST surface — the Node backend is the only path to household and meal data. This is what makes allergy filtering unskippable (see [ARCHITECTURE.md §4.3](docs/ARCHITECTURE.md)); do not re-enable it to "just query from the frontend."
- **JWT signing is asymmetric (ES256)**, so the backend verifies tokens against the JWKS endpoint and never holds a signing secret.

Where the values in `.env` come from: **Project Settings → Database** for the connection string, and `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json` for `SUPABASE_JWKS_URL`. The backend needs neither the service-role key nor the JWT secret — it only ever verifies tokens.

### Free-tier projects pause after ~7 days of inactivity

Expected during intermittent solo work, **not an outage and not a bug**. The first sign is connection timeouts against the cloud database. Resume it from the Supabase dashboard (one click); nothing is lost. Local development is unaffected — `supabase start` doesn't pause.

## Migrations

Plain SQL in `supabase/migrations/`, applied in filename order. No ORM schema layer: RLS policies have to live in SQL regardless, and a second schema notation on top would mean the schema is defined in two places ([DECISION_LOG 2026-08-02](docs/engineering/DECISION_LOG.md)).

> ### ⚠ Adding a table? It needs two grants, or the backend silently reads nothing
>
> The backend connects as **`matmatch_app`**, a least-privilege role with no RLS bypass. Nothing is granted to it automatically — there is deliberately no `ALTER DEFAULT PRIVILEGES` — so **every new table holding application data needs both of these in its own migration**:
>
> ```sql
> grant select, insert, update, delete on public.<table> to matmatch_app;
>
> create policy <name> on public.<table>
>   for select to authenticated, matmatch_app   -- ← the role must be in the TO clause
>   using (...);
> ```
>
> Forget the **grant** and you get `permission denied` — loud and obvious. Forget the role in the **`TO` clause** and RLS matches no policy for it, which is *not* an error: the backend reads **zero rows, forever, with no failure**. That silence is the slowest possible thing to diagnose, which is why this warning is here and repeated in `supabase/migrations/20260803120000_least_privilege_app_role.sql`.

RLS is enabled **and forced** on every table holding household data, and since #53 it genuinely constrains the backend: repository calls run inside a transaction that sets the request's user as the RLS claim (`src/db/context.ts`), so a query that forgets an owner filter returns nothing rather than another household's rows.

It is still defense-in-depth, not the authorization mechanism — the backend does its own checks. A connection with `rolbypassrls` (`postgres`, `supabase_admin`, service-role) bypasses policies entirely; that is why `DATABASE_URL` must point at `matmatch_app` and nothing else.

### The application role's password

The migration creates `matmatch_app` **without a password**, because a password in a committed migration would be a credential installed into the cloud project by `supabase db push`. A role with no password cannot authenticate, so this fails closed.

- **Locally:** `supabase/seed.sql` sets a throwaway password on `supabase db reset`. Nothing to do.
- **Cloud:** set one once, in the dashboard SQL editor, and put it in the deployed `DATABASE_URL`:
  ```sql
  alter role matmatch_app with password '<generated>';
  ```
  Until you do, the deployed backend cannot connect at all — which is the intended failure mode, not a bug.
