import { defineConfig } from "vitest/config";

// The backend suite (Node, real Postgres/JWKS fixtures) and the frontend suite
// (jsdom, its own vitest install under web/) are deliberately separate — `web/`
// has its own `npm test`. Excluding it here keeps `npm test` at the repo root
// scoped to the backend, unaffected by the frontend's existence.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "web/**"],
    // Resets `dish_generation_attempts` once before any test file starts — see the
    // fixture's own comment for why this table (and not the others near it) needs
    // it (#155).
    globalSetup: ["./src/db/__fixtures__/globalSetup.ts"],
    // Test files normally run in parallel across worker processes, but they all
    // share the one real local Postgres instance (src/db/__fixtures__/localStack.ts)
    // — fine for tests scoped to their own household or key, but
    // guided.test.ts's "pantry input is never persisted" check snapshots every
    // table's row count before and after one request and asserts nothing changed
    // anywhere. That assertion is only meaningful if nothing else touches the
    // database in the same window, so this suite runs its files sequentially
    // rather than trying to carve out one exception (#155).
    fileParallelism: false,
  },
});
