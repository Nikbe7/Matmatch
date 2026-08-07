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
npm run dev          # tsx watch — restarts on file change, reads .env
npm start            # one-shot, no watch, reads .env
npm run start:cloud  # one-shot against the cloud project, reads .env.cloud instead
```

Reads `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_JWT_AUDIENCE`, and `PORT` (default `3000`) from `.env` — same values as above. `SUPABASE_URL` is the project base URL; the JWKS endpoint and expected token issuer are both derived from it (`src/auth/verifyToken.ts`), so there's a single value to point at local vs. cloud rather than two kept in sync by hand. Loads `data/*.json` into memory once at startup (not per request) and exits if that fails.

`GET /health` needs nothing else and is what a host's health check should hit. Every route under `/api` requires `Authorization: Bearer <token>` — a Supabase-issued access token, verified against the JWKS endpoint derived from `SUPABASE_URL`.

`npm run start:cloud` loads `.env.cloud` instead of `.env` via Node's built-in `--env-file` — no dotenv, no config framework. Keep cloud credentials in `.env.cloud` (gitignored, like `.env`) rather than switching `.env` back and forth between local and cloud values.

There's also `npm run start:prod` (no `--env-file` at all), which is what the deployed image runs — in production every value comes from Fly's environment, not a file. It additionally reads `WEB_DIST`: when set, the process also serves the built frontend from that directory, which is what makes the deployed service single-origin. It's unset locally, so nothing above changes. See [Deploying](#deploying).

**If database tests skip when the stack *is* up**, check the auth gateway: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:54321/auth/v1/.well-known/jwks.json`. A `502` means Kong is holding a stale upstream after `supabase db reset` restarted GoTrue. Fix:

```bash
docker restart supabase_kong_matmatch
```

## Frontend

`web/` is a Vite + React + TypeScript PWA client — household onboarding, the Tonight card with its adjustment chips, reroll and "Lagad ikväll", the shopping list, and instructions, all backed by the real auth/API chain (login → JWT → `GET /api/tonight`).

```bash
cd web
npm install
cp .env.example .env    # fill in VITE_SUPABASE_ANON_KEY from `npx supabase status` (repo root)
npm run dev              # http://127.0.0.1:5173
```

Run the backend (`npm run dev` at the repo root, port `3000`) alongside it. Vite's dev server proxies `/api/*` to `http://127.0.0.1:3000`, so the browser only ever talks to `5173` — no CORS configuration exists or is needed in development. **Production is intended to be same-origin**: one service serves the built static files and the API together, so CORS stays unnecessary there too; do not add it preemptively.

The frontend never mints, stores, or refreshes its own token — it reads the session from `@supabase/supabase-js` and sends `session.access_token` as `Authorization: Bearer <token>` on each API call.

### Testing the service worker and offline behavior locally

`npm run dev` never runs a service worker — it doesn't build one (`devOptions.enabled: false` in `vite.config.ts`) — so offline/install behavior can only be checked against a real production build, served by `npm run preview`:

```bash
npm run dev              # repo root, port 3000 — the backend, needed for the API proxy below
cd web
npm run build
npm run preview          # http://localhost:4173, serving dist/ for real
```

Open **`http://localhost:4173`** — `localhost` specifically, not a LAN IP (e.g. `192.168.x.x`): a service worker only registers in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts), and `localhost` is special-cased as one over plain HTTP while a bare IP is not, so opening the app via a LAN IP silently gets no service worker at all.

Then, in DevTools:
- **Application → Manifest** — confirm it's installable (all four icon sizes listed, no errors).
- **Application → Service Workers** — confirm one worker is registered and activated for `/sw.js`.
- **Network → Offline** (or actually disconnect), then reload — the app shell must still open, and any saved shopping list must still render (`localStorage` key `matmatch.shoppingList`).
- **Cache eviction** — make a trivial change, rebuild, and reload with Service Workers → "Update"; the old `matmatch-shell-*` entry in Application → Cache Storage should be gone, replaced by exactly one new one.

**Phone installation is not possible against this local stack.** "Add to Home Screen" / `beforeinstallprompt` both require the same secure-context rule above, and on a physical phone that means real HTTPS — `localhost` doesn't apply there, and Supabase's local stack (`supabase start`) isn't reachable from another device either. Verifying an actual install therefore needs a deployed HTTPS environment, which **does not exist yet** — see [Deploying](#deploying) below. Until it does, the preview-mode checklist above plus DevTools mobile emulation are the full extent of what's verifiable, and real phone installation stays unverified.

**Hard-reload caveat**: once a service worker is registered, a plain reload can keep serving an old cached bundle from a *previous* local build even after you rebuild, because the old worker is still active until a new one takes over. If a change doesn't seem to show up, either close and reopen the tab (so the new worker's `clients.claim()` takes effect) or do a real hard reload (DevTools → Application → Service Workers → "Update on reload", or unregister and reload). This is exactly the failure mode `sw.ts`'s cache-name versioning and `evictOldCaches` exist to prevent for real deploys — see `web/src/sw.test.ts`.

**Automated offline check — `npm run test:e2e` (in `web/`)**: a one-test Playwright suite (`web/e2e/offline.spec.ts`) that builds the app, serves it, loads it, asserts `navigator.serviceWorker.controller` is non-null, goes offline, reloads, and asserts the shell actually rendered. This exists because manual verification of this exact flow failed five times in a row before catching a real bug (a `Vary: Origin` response header making a precached, content-hashed file silently miss its own cache entry for a CORS-mode request) — the DevTools checklist above is good for a human pass, but this is what actually catches a regression here going forward. `npx playwright install chromium` once, first time; the suite manages its own build+preview server (see `web/playwright.config.ts`), so nothing else needs to be running first.

## Deploying

> **No deployment exists yet.** There is no live URL, no Fly app, and nothing running or costing anything. Everything below is a ready, tested procedure — the Dockerfile, `fly.toml`, hosted Supabase project and migrations are all in place — but `fly apps create` has never been run. It's gated on adding a payment method to the Fly account (issue #99), not on any remaining work. The **hosted Supabase project does exist** and holds the applied migrations.

One Node service serves the built frontend **and** the API from a single origin — `web/dist` as static files, `/api/*` as the API, and any unknown non-`/api` path falling back to `index.html` so client-side routing and direct deep links both work (`src/api/static.ts`). That's what keeps CORS unnecessary in production, the same way Vite's proxy does locally. The target is Fly.io in `arn` (Stockholm), next to the Supabase project.

None of this affects local development: the process serves static files only when `WEB_DIST` is set, which nothing local sets.

The deployed process is the same `src/api/server.ts` as local — it serves static files only when `WEB_DIST` is set, which the Dockerfile sets and your machine doesn't.

### One-time setup

```bash
fly auth login
fly apps create matmatch                    # region comes from fly.toml (arn)
```

Runtime secrets live in Fly's secret store, never in the repo or the image:

```bash
fly secrets set \
  DATABASE_URL='postgresql://matmatch_app.<project-ref>:<password>@aws-0-eu-north-1.pooler.supabase.com:5432/postgres' \
  SUPABASE_URL='https://<project-ref>.supabase.co' \
  SUPABASE_JWT_AUDIENCE='authenticated'
```

Use the **session pooler** host above, not `db.<project-ref>.supabase.co` — the direct host is IPv6-only, and it's the right choice for a long-lived Node backend anyway. `ANTHROPIC_API_KEY` is optional: without it `/api/instructions` returns the null-instructions failure path instead of refusing to start.

### Deploy

```bash
npm run typecheck && npm test               # and `npm test` in web/
fly deploy \
  --build-arg VITE_SUPABASE_URL='https://<project-ref>.supabase.co' \
  --build-arg VITE_SUPABASE_ANON_KEY='<anon key>'
```

That one command builds the frontend inside the image, assembles the runtime image, and releases it. `npm run deploy` is the same thing without the build args, so it only works once you've deployed with them at least once.

> **The `VITE_*` values are compiled into the JavaScript bundle at image build time**, not read at runtime — Vite substitutes `import.meta.env.VITE_*` during `vite build`. **Changing either one requires a rebuild and redeploy; `fly secrets set` plus a restart does nothing.** They're both public by design (the anon key is meant to ship in a browser bundle, and the Data API is disabled), so passing them as build args exposes nothing — which is exactly why the database password and any Anthropic key are runtime secrets instead. Build args are recoverable from image history; runtime secrets are not in the image at all.

### Migrations against the hosted project

Migrations are applied from your machine, never from inside the container:

```bash
npx supabase db push --db-url 'postgresql://postgres.<project-ref>:<db-password>@aws-0-eu-north-1.pooler.supabase.com:5432/postgres'
```

Order matters on the first deploy: `matmatch_app` is created **without a password** (see "The application role's password"), so until you set one the deployed backend cannot connect at all. That's the intended fail-closed behavior, not a bug.

> ⚠ **Verify a new table's RLS against the hosted project, not just locally.** Hosted Supabase auto-enables RLS on new tables in `public`; local Postgres does not. A migration that relies on RLS being *off* by default therefore produces a different result in the cloud — the table ends up with RLS on and no policies, and `matmatch_app` (no bypass) silently reads **zero rows** while every local test passes. This actually happened to `recipe_instructions` (#99, DECISION_LOG 2026-08-07). State RLS explicitly in the migration rather than relying on a default, and check with:
>
> ```sql
> select relname, relrowsecurity, relforcerowsecurity
> from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r';
> ```

### Rolling back

```bash
fly releases                       # list releases, newest first
fly releases --image               # same, with the image each one shipped
fly deploy --image <previous-image-ref>
```

Redeploying a previous image rolls back the application, but **not** the database — a migration that already ran stays applied. If a release depends on a schema change, roll the schema back with a new forward migration rather than expecting the image rollback to cover it.

### Health check

Fly checks `GET /health` every 30s. It's unauthenticated and deliberately touches neither the database nor the engine data (`src/api/routes/health.ts`) — if it queried Postgres, a DB blip or a paused free-tier project would fail the check and put Fly into a restart loop on a service that is otherwise fine.

### Uptime expectations

Once deployed, the Fly machine will be always on (`min_machines_running = 1`, `auto_stop_machines = false`), so no cold starts. The **Supabase** project is separate and does pause — see ["Free-tier projects pause"](#free-tier-projects-pause-after-7-days-of-inactivity) above. When it does, the app fails on database connect while `/health` keeps answering 200; that's deliberate, and it's what stops a paused database from becoming a restart loop.

The hosted project is already provisioned and idle, so **expect it to be paused by the time the first deploy happens** — wake it from the dashboard first. Expected, not a bug.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Vitest, once — backend only, `web/` has its own suite |
| `npm run typecheck` | `tsc --noEmit`, then the frontend's typecheck |
| `npm run build` | Builds the frontend (`vite build`) — the backend has no build step, it runs directly under `tsx` |
| `npm run deploy` | `fly deploy` — see [Deploying](#deploying); needs the `VITE_*` build args on a first deploy |
| `npm run validate` | Validates `data/*.json` against the locked schemas |
| `npx supabase db reset` | Recreates the local database from `supabase/migrations/` |
| `npx supabase migration new <name>` | Scaffolds a new migration file |
| `npm test` / `npm run typecheck` (inside `web/`) | Frontend's own Vitest suite (jsdom) and `tsc -b` |
| `npm run test:e2e` (inside `web/`) | The one Playwright test (offline/service-worker) — not part of `npm test`, see "Testing the service worker" above |

## The Supabase project

One project, **`eu-north-1` (Stockholm)** — fixed at provisioning. Allergy data is sensitive personal data under GDPR ([ARCHITECTURE.md §7](docs/ARCHITECTURE.md)), and a Supabase project's region cannot be changed afterwards; moving it means creating a new project and migrating.

Two settings on it are load-bearing, not defaults:

- **Data API (PostgREST) is disabled**, and "automatically expose new tables" is off. There is no client-facing REST surface — the Node backend is the only path to household and meal data. This is what makes allergy filtering unskippable (see [ARCHITECTURE.md §4.3](docs/ARCHITECTURE.md)); do not re-enable it to "just query from the frontend."
- **JWT signing is asymmetric (ES256)**, so the backend verifies tokens against the JWKS endpoint and never holds a signing secret.

Where the values in `.env` come from: **Project Settings → Database** for the connection string, and **Project Settings → API** for the project URL (`https://<project-ref>.supabase.co`) that `SUPABASE_URL` is set to. The backend needs neither the service-role key nor the JWT secret — it only ever verifies tokens.

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
>
> Grant only the verbs the table actually needs, rather than all four by reflex — and give it a policy per granted verb. `cooked_meals` (#88) grants `select, insert` and has exactly those two policies, because cooked history is append-only and nothing in the application rewrites a past evening; a `delete` grant it never uses is only a way for a future bug to erase data. Note the asymmetry the trap above creates: a *missing* grant fails loudly, so narrowing is safe, while a granted verb with no matching policy is the silent-zero-rows case.

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
