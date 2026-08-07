import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// Guards a failure class that came up while investigating issue #93's
// white-screen bug, not the bug's actual cause: an early hypothesis was that
// workbox injectManifest's default 2 MiB precache-file-size cap was silently
// dropping the JS bundle from the manifest. That was ruled out (the bundle
// is ~408 KiB, comfortably under the cap, and was genuinely present in
// dist/sw.js) — the real cause was a `Vary: Origin` cache-match miss at
// *runtime* despite a correct manifest, fixed in sw.ts's handleFetch and
// covered by sw.test.ts and web/e2e/offline.spec.ts (see DECISION_LOG
// 2026-08-07). This test stays because the hypothesis, even though wrong
// here, is a real failure mode worth guarding against on its own: an asset
// the shell needs at startup missing from the precache manifest, for any
// reason (size cap, a glob pattern gap, a future build tool change). It runs
// a real production build and cross-checks every script/stylesheet
// dist/index.html actually loads against the manifest injected into
// dist/sw.js.

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

beforeAll(() => {
  execFileSync("npx", ["vite", "build"], { cwd: webDir, stdio: "pipe" });
}, 60_000);

interface PrecacheEntry {
  url: string;
  revision: string | null;
}

function readPrecacheEntries(): PrecacheEntry[] {
  const swSrc = readFileSync(path.join(webDir, "dist/sw.js"), "utf8");
  const entryPattern = /\{"revision":(?:"[a-f0-9]+"|null),"url":"[^"]+"\}/g;
  return (swSrc.match(entryPattern) ?? []).map((raw) => JSON.parse(raw) as PrecacheEntry);
}

/** Every script/stylesheet dist/index.html loads at startup, root-relative paths stripped of their leading slash to match the precache manifest's URL format. */
function referencedShellAssets(): string[] {
  const html = readFileSync(path.join(webDir, "dist/index.html"), "utf8");
  const referencePattern = /(?:src|href)="\/(assets\/[^"]+|[^"?]+\.(?:js|css))"/g;
  const found = new Set<string>();
  for (const match of html.matchAll(referencePattern)) found.add(match[1]!);
  return [...found];
}

describe("PWA precache manifest (built dist/)", () => {
  it("precaches every script and stylesheet dist/index.html references", () => {
    const referenced = referencedShellAssets();
    const precachedUrls = new Set(readPrecacheEntries().map((entry) => entry.url));

    // Asserted separately from the loop below: a build that stops emitting a
    // <script> tag entirely would otherwise make the loop below vacuously
    // pass on zero assertions.
    expect(referenced.length).toBeGreaterThan(0);

    for (const url of referenced) {
      expect(precachedUrls.has(url), `"${url}" is loaded by index.html but missing from the precache manifest`).toBe(
        true,
      );
    }
  });

  it("keeps every precached JS/CSS file under the precache size cap that would silently drop it", () => {
    // workbox injectManifest's default `maximumFileSizeToCacheInBytes` — not
    // configured explicitly in vite.config.ts, so this is the cap actually in
    // effect. A file over this limit is dropped from the manifest with no
    // build error or warning, which is exactly how this bug would recur
    // silently if the bundle ever grows past it.
    const MAX_PRECACHE_BYTES = 2 * 1024 * 1024;

    const jsAndCssEntries = readPrecacheEntries().filter((entry) => /\.(js|css)$/.test(entry.url));
    expect(jsAndCssEntries.length).toBeGreaterThan(0);

    for (const entry of jsAndCssEntries) {
      const { size } = statSync(path.join(webDir, "dist", entry.url));
      expect(
        size,
        `"${entry.url}" is ${size} bytes — over the ${MAX_PRECACHE_BYTES}-byte (2 MiB) precache cap, so it would be silently dropped from the manifest`,
      ).toBeLessThan(MAX_PRECACHE_BYTES);
    }
  });
});
