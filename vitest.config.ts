import { defineConfig } from "vitest/config";

// The backend suite (Node, real Postgres/JWKS fixtures) and the frontend suite
// (jsdom, its own vitest install under web/) are deliberately separate — `web/`
// has its own `npm test`. Excluding it here keeps `npm test` at the repo root
// scoped to the backend, unaffected by the frontend's existence.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "web/**"],
  },
});
