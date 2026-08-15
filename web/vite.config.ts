import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// Dev/preview-only proxy: the browser calls same-origin `/api/*`, Vite forwards it
// to the backend on :3000 (configured separately below for `server` and
// `preview` — Vite does not share one between them). Production is intended to
// be one service serving the built static files and the API from the same
// origin, so this proxy is a local convenience only — CORS should never need
// configuring on the backend.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // `injectManifest`, not the default `generateSW`: the never-cache-`/api/*`
    // rule and cache-version eviction (issue #93) are safety-critical enough
    // that they need to be plain, readable, unit-tested code in `src/sw.ts`,
    // not workbox-generated output we're trusting blindly. This plugin is used
    // for exactly one thing — replacing `self.__WB_MANIFEST` in that file with
    // the real, content-hashed list of built shell files at build time.
    // `manifest: false` because `public/manifest.webmanifest` is already a
    // complete, hand-written manifest with the Swedish user-facing strings;
    // generating a second one here would just be something to keep in sync.
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      manifest: false,
      injectManifest: {
        // The service worker itself is regenerated on every build (its own
        // content changes), so it must never be precached — doing so would
        // pin the browser to whichever service worker script happened to be
        // cached, defeating the version-eviction logic inside it.
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest,woff2}"],
      },
      // No dev-mode service worker: the whole point of `npm run dev`'s proxy
      // is to see live changes, which a caching worker would fight.
      devOptions: { enabled: false },
      injectRegister: false,
    }),
  ],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
  // Same proxy, repeated for `npm run preview`: preview serves the actual built
  // output (dist/), which is the only mode with a registered service worker
  // (`npm run dev` never builds one — see devOptions.enabled: false above) — so
  // it's the only mode the PWA/offline behavior can be verified in at all.
  // Without this, every `/api/*` request against the preview server 404s.
  preview: {
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
  test: {
    // Playwright owns e2e/ (its own runner, its own `expect` — see
    // playwright.config.ts); vitest's default include glob would otherwise
    // also pick up `*.spec.ts` there and fail trying to run it as a unit test.
    exclude: ["**/node_modules/**", "e2e/**"],
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
