// The app-shell service worker (issue #93). Hand-written rather than
// workbox-generated: the two rules that matter most here — never cache
// `/api/*`, and a new deploy always evicts the old cache — need to be plain,
// readable, unit-testable code, not something to trust a generated bundle got
// right. `vite-plugin-pwa` (injectManifest strategy) is used only to replace
// `self.__WB_MANIFEST` below with the real, content-hashed list of built
// shell files at build time; everything else here is ours.
//
// The exported functions are pure (cache/cacheStorage passed in) so
// sw.test.ts can exercise them directly, without a real service worker
// runtime. The registration block at the bottom is the only part that
// touches the real global scope, and it no-ops under any environment that
// isn't an actual service worker (e.g. importing this file under vitest).

export interface PrecacheEntry {
  url: string;
  revision: string | null;
}

const CACHE_PREFIX = "matmatch-shell-";

/**
 * Deterministic per build: the precache manifest changes whenever any shell
 * file's build output changes, so hashing it — rather than using a fixed
 * name — guarantees a new deploy gets a new cache name. That is what makes
 * evictOldCaches() below able to tell "old" from "current" at all; a stale
 * bundle served from a service worker is the single most likely way this
 * feature breaks.
 */
export function computeCacheName(manifest: readonly PrecacheEntry[]): string {
  const raw = JSON.stringify(manifest);
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (Math.imul(hash, 31) + raw.charCodeAt(i)) | 0;
  }
  return `${CACHE_PREFIX}${(hash >>> 0).toString(36)}`;
}

/**
 * `/api/*` must never be served from, or written to, any cache — a cached
 * authenticated response is stale data at best and cross-account leakage at
 * worst. This is the single choke point for that rule, checked first in
 * handleFetch() below, so it can never become an accidental side effect of
 * whatever the precache glob happens to match.
 */
export function isApiRequest(url: URL): boolean {
  return url.pathname.startsWith("/api/");
}

export async function precacheShell(
  cache: Pick<Cache, "addAll">,
  manifest: readonly PrecacheEntry[],
): Promise<void> {
  await cache.addAll(manifest.map((entry) => entry.url));
}

/** Deletes every cache this service worker owns except the current one. */
export async function evictOldCaches(
  cacheStorage: Pick<CacheStorage, "keys" | "delete">,
  currentCacheName: string,
): Promise<void> {
  const keys = await cacheStorage.keys();
  await Promise.all(
    keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== currentCacheName)
      .map((key) => cacheStorage.delete(key)),
  );
}

/**
 * Cache-first for the app shell, network-only (never touching the cache) for
 * `/api/*`, and — for a navigation that fails outright, i.e. offline — a
 * fallback to the cached shell so a reload opens the app instead of the
 * browser's own offline error page.
 */
export async function handleFetch(request: Request, cache: Pick<Cache, "match">): Promise<Response> {
  const url = new URL(request.url);

  if (isApiRequest(url)) {
    return fetch(request);
  }

  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    return await fetch(request);
  } catch (err) {
    if (request.mode === "navigate") {
      const shell = await cache.match("/index.html");
      if (shell) return shell;
    }
    throw err;
  }
}

interface WaitUntilEvent {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchLikeEvent extends WaitUntilEvent {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
}

interface ServiceWorkerScope {
  clients?: { claim(): Promise<void> };
  addEventListener(type: "install" | "activate", listener: (event: WaitUntilEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchLikeEvent) => void): void;
  skipWaiting(): void;
}

// Only a real service worker global scope has `clients` — importing this
// module in any other context (the vitest suite, a stray browser tab) must
// never register these listeners.
const worker = self as unknown as ServiceWorkerScope;

if (typeof self !== "undefined" && "clients" in worker) {
  // Must stay as the literal, unwrapped expression `self.__WB_MANIFEST` —
  // vite-plugin-pwa (injectManifest) finds and replaces exactly this token in
  // the built output with the real, content-hashed list of shell files.
  // Reading it through the `worker` alias above would compile away the
  // literal and silently break injection.
  // @ts-expect-error — __WB_MANIFEST does not exist until injectManifest adds it
  const manifest: PrecacheEntry[] = self.__WB_MANIFEST ?? [];
  const CACHE_NAME = computeCacheName(manifest);

  worker.addEventListener("install", (event) => {
    event.waitUntil(
      caches
        .open(CACHE_NAME)
        .then((cache) => precacheShell(cache, manifest))
        .then(() => worker.skipWaiting()),
    );
  });

  worker.addEventListener("activate", (event) => {
    event.waitUntil(evictOldCaches(caches, CACHE_NAME).then(() => worker.clients?.claim()));
  });

  worker.addEventListener("fetch", (event) => {
    event.respondWith(caches.open(CACHE_NAME).then((cache) => handleFetch(event.request, cache)));
  });
}
