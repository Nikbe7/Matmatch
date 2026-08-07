# One image, one process: the Node service serves the built frontend and the API from
# a single origin (issue #99). No orchestration, no process manager, no nginx in
# front — Express serves the static files itself (src/api/static.ts).

# ---- Stage 1: build the frontend ---------------------------------------------
# Node 24 (LTS). The repo develops on 25, but an image should sit on a line that
# receives security updates for years rather than months.
FROM node:24-alpine AS web-build

WORKDIR /app

# The frontend's Supabase URL and anon key are compiled into the bundle by Vite —
# `import.meta.env.VITE_*` is substituted at build time, not read at runtime
# (web/src/supabaseClient.ts). That means CHANGING THESE REQUIRES A REBUILD AND
# REDEPLOY; setting them as Fly secrets and restarting does nothing, because by then
# the values are already baked into the JavaScript. See README, "Deploying".
#
# Both are public by design: the anon key is meant to ship in a browser bundle, and
# this project's Data API is disabled, so the pair cannot reach the database
# (ARCHITECTURE.md §2). No secret is passed as a build arg here — build args are
# recoverable from image history, which is exactly why the service-role key and the
# database password are runtime secrets instead, and never appear in this file.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY

# Root manifests first: the frontend build runs `tsc -b` against the workspace's
# TypeScript, and this layer caches independently of source changes.
COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json ./web/

# Both trees, including the root's dev dependencies. The frontend is not standalone:
# web/src/api.ts and web/src/App.tsx import the shared Zod schemas from the backend's
# `src/schema/*` (one definition of a Household or a RecipeTemplate, not two), so
# `tsc -b` inside web/ has to resolve those files *and* the `zod` they import from the
# root node_modules. This stage is discarded after the build, so none of it reaches
# the runtime image.
RUN npm ci
RUN npm ci --prefix web

COPY tsconfig.json ./
COPY src/ ./src/
COPY web/ ./web/

ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

# Fails the build if either is missing, rather than producing a bundle that throws on
# first load in the browser (supabaseClient.ts throws when they are unset) — a broken
# deploy caught here costs a minute, caught in production it costs a user.
RUN test -n "$VITE_SUPABASE_URL" || (echo "VITE_SUPABASE_URL build arg is required" && exit 1)
RUN test -n "$VITE_SUPABASE_ANON_KEY" || (echo "VITE_SUPABASE_ANON_KEY build arg is required" && exit 1)

RUN npm run build --prefix web

# ---- Stage 2: runtime --------------------------------------------------------
FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Production dependencies only. `tsx` is among them deliberately: the backend has no
# build step and runs its TypeScript directly (README, "Commands"), so tsx is a
# runtime dependency here, not tooling. This skips vitest, the Supabase CLI and the
# rest of the dev tree, which have no business in a deployed image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The backend, its curated data, and the tsconfig tsx resolves against. `data/*.json`
# is loaded once at startup by src/engine/data.ts and the process exits if it fails,
# so it must be present in the image.
COPY tsconfig.json ./
COPY src/ ./src/
COPY data/ ./data/

# The built client from stage 1. Nothing else from that stage comes along — no source,
# no node_modules, no build args in this layer.
COPY --from=web-build /app/web/dist ./web/dist

# What flips the server into single-service mode (src/api/server.ts). Unset locally,
# which is why `npm run dev` is unaffected by any of this.
ENV WEB_DIST=/app/web/dist

# Matches fly.toml's internal_port. The server reads PORT and defaults to 3000.
ENV PORT=8080
EXPOSE 8080

# Drop to the unprivileged user the base image already provides. Nothing here writes
# to disk — the app's only state is in Postgres and the browser's localStorage.
USER node

# Directly, not via npm: npm would sit in the process tree as PID 1 and swallow the
# signals Fly sends to stop a machine cleanly.
CMD ["npx", "tsx", "src/api/server.ts"]
