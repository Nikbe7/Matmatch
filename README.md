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

RLS is enabled **and forced** on every table holding household data, but it is defense-in-depth only — the backend does not rely on it for authorization, and a superuser connection bypasses it entirely. See the decision-log entry for what that does and does not protect against.
