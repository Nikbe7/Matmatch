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
  it("adds every manifest URL to the cache", async () => {
    const cache = { addAll: vi.fn().mockResolvedValue(undefined) };

    await precacheShell(cache, SHELL);

    expect(cache.addAll).toHaveBeenCalledWith(["/index.html", "/assets/index.js"]);
  });
});
