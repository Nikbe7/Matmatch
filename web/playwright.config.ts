import { defineConfig, devices } from "@playwright/test";

// One test, one flow (issue #93): offline behavior only a real browser
// exhibits — a service worker actually reaching "activated" and controlling
// the page — has now defeated five rounds of code-level review. This is
// deliberately not a broader E2E suite: `webServer` below builds and serves
// the real production output, exactly the one thing the app's fast unit
// suite (`npm test`) cannot exercise, and nothing more is added on top of it.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4173",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // The dev server never runs a service worker at all (devOptions.enabled:
    // false in vite.config.ts) — only a real production build does, so this
    // is the one server the offline test can run against.
    command: "npm run build && npm run preview -- --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
