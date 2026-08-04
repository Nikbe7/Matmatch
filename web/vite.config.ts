import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Dev-only proxy: the browser calls same-origin `/api/*`, Vite forwards it to the
// backend on :3000. Production is intended to be one service serving the built
// static files and the API from the same origin, so this proxy is a dev
// convenience only — CORS should never need configuring on the backend.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
  test: {
    environment: "jsdom",
    // jsdom's localStorage is unavailable for the opaque "about:blank" origin it
    // defaults to without an explicit url — the shopping list's persistence tests
    // need a real one. Separately, Node >=22's own built-in `localStorage` global
    // (stable, always present) shadows jsdom's and is non-functional without a
    // `--localstorage-file`, so the "test" script in package.json also disables it
    // via NODE_OPTIONS=--no-experimental-webstorage — both are needed together.
    environmentOptions: {
      jsdom: { url: "http://localhost/" },
    },
  },
});
