// Registers the app-shell service worker (sw.ts, issue #93) built by
// vite-plugin-pwa into dist/sw.js. Production only — `npm run dev` never
// registers one, matching the plugin's own devOptions.enabled: false, so a
// stale worker from a previous build can never shadow live dev changes.
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      // A failed registration must not break the app itself — it just means
      // this visit won't get offline support, same as any browser that
      // doesn't support service workers at all — but it must not be silent
      // either (issue #93's second bug shipped invisibly for exactly this
      // reason).
      console.error("[sw] registration failed:", error);
    });
  });
}
