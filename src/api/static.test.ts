import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { staticRouter } from "./static.js";

// No database and no auth: this is the single-origin static/SPA behaviour on its own,
// so it runs everywhere rather than skipping without the local stack. The dist
// directory is a fixture built here rather than a real `vite build`, because what is
// under test is the serving rules — cache headers and fallback routing — not Vite.

let distDir: string;
let app: express.Express;

beforeAll(async () => {
  distDir = await fs.mkdtemp(path.join(os.tmpdir(), "matmatch-dist-"));
  await fs.mkdir(path.join(distDir, "assets"), { recursive: true });

  await fs.writeFile(path.join(distDir, "index.html"), "<!doctype html><title>shell</title>");
  await fs.writeFile(path.join(distDir, "sw.js"), "// service worker");
  await fs.writeFile(path.join(distDir, "manifest.webmanifest"), '{"name":"Matmatch"}');
  await fs.writeFile(path.join(distDir, "assets", "index-abc123.js"), "console.log(1)");
  await fs.writeFile(path.join(distDir, "icon-192.png"), "not-really-a-png");

  app = express();
  // Stands in for the API routers, which are mounted before the static router in
  // createApp — enough to prove the fallback does not shadow them.
  app.get("/api/tonight", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.use(staticRouter(distDir));
});

afterAll(async () => {
  await fs.rm(distDir, { recursive: true, force: true });
});

describe("static file serving", () => {
  it("serves a content-hashed asset as immutable for a year", async () => {
    const response = await request(app).get("/assets/index-abc123.js");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it.each(["/index.html", "/sw.js", "/manifest.webmanifest"])(
    "never caches %s",
    async (urlPath) => {
      const response = await request(app).get(urlPath);

      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-cache");
    },
  );

  it("caches an unhashed, non-shell file conservatively rather than immutably", async () => {
    const response = await request(app).get("/icon-192.png");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=86400");
  });
});

describe("SPA fallback", () => {
  it("returns the shell for an unknown path, so a deep link renders the app", async () => {
    const response = await request(app).get("/nagon/djup/lank");

    expect(response.status).toBe(200);
    expect(response.text).toContain("<title>shell</title>");
  });

  it("returns the shell for the root path", async () => {
    const response = await request(app).get("/");

    expect(response.status).toBe(200);
    expect(response.text).toContain("<title>shell</title>");
  });

  it("does not cache the shell it falls back to", async () => {
    const response = await request(app).get("/nagon/djup/lank");

    expect(response.headers["cache-control"]).toBe("no-cache");
  });

  it("leaves a real API route alone", async () => {
    const response = await request(app).get("/api/tonight");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it("does not answer an unknown /api path with the app shell", async () => {
    // It stays a 404 (Express's stock one) rather than becoming a 200 carrying the
    // shell: the service worker forces /api/* to the network and web/src/api.ts
    // parses the result as JSON, so a shell here would surface as a parse error.
    const response = await request(app).get("/api/does-not-exist");

    expect(response.status).toBe(404);
    expect(response.text).not.toContain("<title>shell</title>");
  });

  it("does not hijack a non-GET request to an unknown path", async () => {
    const response = await request(app).post("/nagon/djup/lank");

    expect(response.status).toBe(404);
  });
});
