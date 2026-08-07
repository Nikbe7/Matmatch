import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeCacheName,
  evictOldCaches,
  handleFetch,
  isApiRequest,
  precacheShell,
  type PrecacheEntry,
} from "./sw";

// Unit-level: exercises the service worker's pure fetch/cache logic directly
// (issue #93), without a real ServiceWorkerGlobalScope. The two things that
// matter most here — `/api/*` never touches a cache, and a version bump
// evicts everything the previous build cached — are exactly what these cover.

const SHELL: readonly PrecacheEntry[] = [
  { url: "/index.html", revision: "abc123" },
  { url: "/assets/index.js", revision: "def456" },
];

describe("isApiRequest", () => {
  it("matches any /api/ path", () => {
    expect(isApiRequest(new URL("https://app.example/api/tonight"))).toBe(true);
    expect(isApiRequest(new URL("https://app.example/api/analytics/events"))).toBe(true);
  });

  it("does not match the app shell", () => {
    expect(isApiRequest(new URL("https://app.example/"))).toBe(false);
    expect(isApiRequest(new URL("https://app.example/assets/index.js"))).toBe(false);
  });
});

describe("handleFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never reads /api/* from the cache, and goes straight to the network", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const cache = { match: vi.fn().mockResolvedValue(new Response("cached")) };

    const response = await handleFetch(new Request("https://app.example/api/tonight"), cache);

    expect(cache.match).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("{}");
  });

  it("never falls back to a cached response for a failed /api/* request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    const cache = { match: vi.fn().mockResolvedValue(new Response("stale-api-response")) };

    await expect(
      handleFetch(new Request("https://app.example/api/tonight"), cache),
    ).rejects.toThrow("network down");
    expect(cache.match).not.toHaveBeenCalled();
  });

  it("serves the app shell from the cache without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const cache = { match: vi.fn().mockResolvedValue(new Response("shell")) };

    const response = await handleFetch(new Request("https://app.example/assets/index.js"), cache);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await response.text()).toBe("shell");
  });

  it("falls back to the cached shell for a failed navigation when offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const cache = {
      match: vi.fn((request: Request | string) => {
        const url = typeof request === "string" ? request : request.url;
        return Promise.resolve(url.endsWith("/index.html") ? new Response("shell") : undefined);
      }),
    };

    // Real `Request` instances reject `mode: "navigate"` at construction time —
    // only the browser's own navigation sets it, never application code — so a
    // plain stand-in is used here for the one field handleFetch reads.
    const navigationRequest = { url: "https://app.example/some/route", mode: "navigate" } as Request;

    const response = await handleFetch(navigationRequest, cache);

    expect(await response.text()).toBe("shell");
  });

  // The regression test for issue #93's third bug: a dev/preview server that
  // sends `Vary: <anything>` (this one sends `Vary: Origin`) makes a plain
  // `cache.match(request)` silently miss a precached, content-hashed shell
  // file for any request whose mode causes the browser to attach a header
  // the cached entry's key didn't record — invisibly, since neither request
  // nor response ever surfaces as a non-200 anywhere. `{ ignoreVary: true }`
  // is the actual fix; this asserts it's actually passed, not just present
  // in a comment.
  it("ignores Vary when matching both the direct cache-first lookup and the offline shell fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const cache = { match: vi.fn().mockResolvedValue(undefined) };

    await handleFetch(new Request("https://app.example/assets/index.js"), cache).catch(() => {});
    expect(cache.match).toHaveBeenCalledWith(expect.anything(), { ignoreVary: true });

    cache.match.mockClear();
    const navigationRequest = { url: "https://app.example/some/route", mode: "navigate" } as Request;
    await handleFetch(navigationRequest, cache).catch(() => {});
    expect(cache.match).toHaveBeenCalledWith("/index.html", { ignoreVary: true });
  });
});

describe("computeCacheName", () => {
  it("is deterministic for the same manifest", () => {
    expect(computeCacheName(SHELL)).toBe(computeCacheName(SHELL));
  });

  it("changes whenever the built shell changes — a version bump", () => {
    const nextBuild: readonly PrecacheEntry[] = [
      { url: "/index.html", revision: "abc123" },
      { url: "/assets/index.js", revision: "NEW-HASH" },
    ];

    expect(computeCacheName(SHELL)).not.toBe(computeCacheName(nextBuild));
  });
});

describe("evictOldCaches", () => {
  it("deletes every previous-build cache and keeps only the current one", async () => {
    const cacheStorage = {
      keys: vi.fn().mockResolvedValue(["matmatch-shell-old1", "matmatch-shell-old2", "matmatch-shell-current"]),
      delete: vi.fn().mockResolvedValue(true),
    };

    await evictOldCaches(cacheStorage, "matmatch-shell-current");

    expect(cacheStorage.delete).toHaveBeenCalledTimes(2);
    expect(cacheStorage.delete).toHaveBeenCalledWith("matmatch-shell-old1");
    expect(cacheStorage.delete).toHaveBeenCalledWith("matmatch-shell-old2");
    expect(cacheStorage.delete).not.toHaveBeenCalledWith("matmatch-shell-current");
  });

  it("leaves caches from other origins/purposes alone", async () => {
    const cacheStorage = {
      keys: vi.fn().mockResolvedValue(["some-other-cache", "matmatch-shell-current"]),
      delete: vi.fn().mockResolvedValue(true),
    };

    await evictOldCaches(cacheStorage, "matmatch-shell-current");

    expect(cacheStorage.delete).not.toHaveBeenCalled();
  });
});

describe("precacheShell", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("caches every manifest URL individually", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok")));
    const cache = { put: vi.fn().mockResolvedValue(undefined) };

    await precacheShell(cache, SHELL);

    expect(cache.put).toHaveBeenCalledTimes(2);
    expect(cache.put).toHaveBeenCalledWith("/index.html", expect.any(Response));
    expect(cache.put).toHaveBeenCalledWith("/assets/index.js", expect.any(Response));
  });

  // The regression test for issue #93's second bug: `cache.addAll()` is
  // all-or-nothing, so one bad URL used to reject the entire install and the
  // worker never activated — with no visible symptom beyond
  // `navigator.serviceWorker.controller` silently staying null. Caching
  // entries individually means this can no longer happen.
  it("does not reject, and still caches the other entries, when one URL fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url === "/index.html"
          ? Promise.resolve(new Response("not found", { status: 404 }))
          : Promise.resolve(new Response("ok")),
      ),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cache = { put: vi.fn().mockResolvedValue(undefined) };

    await expect(precacheShell(cache, SHELL)).resolves.toBeUndefined();

    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledWith("/assets/index.js", expect.any(Response));
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("/index.html"),
      expect.anything(),
    );
  });

  it("does not reject, and still caches the other entries, when one fetch throws outright", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url === "/index.html" ? Promise.reject(new Error("network down")) : Promise.resolve(new Response("ok")),
      ),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cache = { put: vi.fn().mockResolvedValue(undefined) };

    await expect(precacheShell(cache, SHELL)).resolves.toBeUndefined();

    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledWith("/assets/index.js", expect.any(Response));
  });
});
