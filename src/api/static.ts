import express, { Router, type RequestHandler } from "express";
import path from "node:path";

// Serves the built frontend (`web/dist`) from the same origin as the API, which is
// what `web/vite.config.ts` has always documented as the production shape: one
// service, one origin, so CORS never needs configuring and the browser's `/api/*`
// calls are plain same-origin requests.
//
// Mounted only when the server is given a dist directory (see server.ts). Local
// development never is — there, Vite serves the frontend on :5173 and proxies
// `/api/*` here — so this file is inert in the dev path and in every existing test.

/** How long a content-hashed asset may be cached. One year, the practical maximum. */
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Files that must never be cached, even though they sit next to hashed assets.
 *
 * These three have stable names, so a cached copy is never superseded by a new
 * build the way a content-hashed asset is — the browser would keep serving the old
 * one indefinitely:
 *
 *  - `index.html` is the entry point; caching it pins the user to the previous
 *    build's script tags no matter how many times we deploy.
 *  - `sw.js` is the service worker. A stale worker stays in control of the page and
 *    defeats the cache-name versioning and `evictOldCaches` logic inside it
 *    (web/src/sw.ts) — the exact failure this project already hit in issue #93.
 *    Browsers increasingly bypass the HTTP cache for the worker script anyway, but
 *    that is a browser default we should not be depending on.
 *  - `manifest.webmanifest` drives install metadata; a stale one shows the wrong
 *    name or icons on the installed app.
 *
 * `no-cache` (not `no-store`): the browser may keep the file but must revalidate
 * before using it, so an unchanged file still answers 304 rather than re-downloading.
 */
const NEVER_CACHED = new Set(["/index.html", "/sw.js", "/manifest.webmanifest"]);

function isNeverCached(urlPath: string): boolean {
  return NEVER_CACHED.has(urlPath);
}

/**
 * Content-hashed build output. Vite emits these under `/assets/` with the content
 * hash in the filename, so the name changes whenever the bytes do — which is what
 * makes `immutable` safe: a stale copy can never be requested under the same URL.
 */
function isHashedAsset(urlPath: string): boolean {
  return urlPath.startsWith("/assets/");
}

/**
 * Static file serving plus the SPA fallback, as one router.
 *
 * Order inside matters: static files first, so a real file always wins, then the
 * fallback for everything else.
 */
export function staticRouter(distDir: string): Router {
  const router = Router();
  const indexHtml = path.join(distDir, "index.html");

  router.use(
    express.static(distDir, {
      // The fallback below owns unmatched paths; without this, express.static would
      // answer a bare directory request with index.html and skip those headers.
      index: false,
      setHeaders(res, filePath) {
        const urlPath = "/" + path.relative(distDir, filePath).split(path.sep).join("/");

        if (isNeverCached(urlPath)) {
          res.setHeader("Cache-Control", "no-cache");
          return;
        }

        if (isHashedAsset(urlPath)) {
          res.setHeader("Cache-Control", `public, max-age=${ONE_YEAR_SECONDS}, immutable`);
          return;
        }

        // Everything else in dist/ — icons, and anything added later that is neither
        // hashed nor in the never-cache list. Cacheable, but revalidated daily rather
        // than pinned for a year, since the name gives no guarantee the bytes are
        // stable.
        res.setHeader("Cache-Control", "public, max-age=86400");
      },
    }),
  );

  router.use(spaFallback(indexHtml));

  return router;
}

/**
 * Returns `index.html` for any unmatched GET, so client-side routing works and a
 * direct deep link (or a reload on one) renders the app instead of 404ing.
 *
 * `/api/*` is deliberately excluded, so an unknown API path keeps falling through to
 * a 404 instead of being answered with the app shell. Returning HTML *that renders as
 * the application* for a mistyped or removed endpoint is the bad outcome: the service
 * worker forces `/api/*` to the network (web/src/sw.ts) and `web/src/api.ts` parses
 * the result as JSON, so a 200-with-shell would surface as a confusing parse error
 * instead of an obvious 404.
 *
 * That 404 is currently Express's stock HTML error page rather than JSON — unchanged
 * by this router, and left alone here because this slice is not the place to alter
 * API responses. Worth tightening to JSON separately if it ever costs debugging time.
 */
export function spaFallback(indexHtmlPath: string): RequestHandler {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api/")) return next();

    // Same reasoning as the static handler above: the shell must revalidate, or a
    // deploy never reaches anyone holding a cached copy.
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(indexHtmlPath, (error) => {
      if (error) next(error);
    });
  };
}
