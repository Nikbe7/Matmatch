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
  },
});
