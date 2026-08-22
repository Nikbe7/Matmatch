import ImageKit from "@imagekit/nodejs";
import type { Express } from "express";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createTokenVerifier } from "../../auth/verifyToken.js";
import type { Sql } from "../../db/client.js";
import {
  LOCAL_ISSUER,
  LOCAL_JWKS_URL,
  appClient,
  createTestUser,
  isLocalStackAvailable,
} from "../../db/__fixtures__/localStack.js";
import { makeEngineData } from "../../engine/__fixtures__/engineData.js";
import { createApp } from "../app.js";

// GET /api/imagekit/auth, against the real local Supabase stack for auth (real bearer
// token, no mock) — what this proves is the wiring: an authenticated caller gets back
// signed upload params, and an unauthenticated one gets 401 before ever reaching
// ImageKit. The signature itself is ImageKit's own SDK, not something to re-verify
// here; a fake private key is enough to exercise getAuthenticationParameters().

const stackAvailable = await isLocalStackAvailable();

let sql: Sql | undefined;
let verifyToken: ReturnType<typeof createTokenVerifier> | undefined;

if (stackAvailable) {
  sql = appClient();
  verifyToken = createTokenVerifier({
    jwksUrl: LOCAL_JWKS_URL,
    issuer: LOCAL_ISSUER,
    audience: "authenticated",
  });
}

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

const engineData = makeEngineData({ ingredients: [], templates: [] });

function buildApp(configured: boolean): Express {
  return createApp({
    sql: sql!,
    engineData,
    verifyToken: verifyToken!,
    imagekitClient: configured ? new ImageKit({ privateKey: "test_private_key" }) : undefined,
    imagekitPublicKey: configured ? "test_public_key" : undefined,
  });
}

describe.skipIf(!stackAvailable)("GET /api/imagekit/auth", () => {
  it("returns 401 without a token", async () => {
    const app = buildApp(true);

    const response = await request(app).get("/api/imagekit/auth");

    expect(response.status).toBe(401);
  });

  it("returns signed upload params for an authenticated caller", async () => {
    const app = buildApp(true);
    const user = await createTestUser();

    const response = await request(app).get("/api/imagekit/auth").set(authHeader(user.accessToken));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      token: expect.any(String),
      expire: expect.any(Number),
      signature: expect.any(String),
      publicKey: "test_public_key",
    });
  });

  it("returns 503 when imagekit isn't configured", async () => {
    const app = buildApp(false);
    const user = await createTestUser();

    const response = await request(app).get("/api/imagekit/auth").set(authHeader(user.accessToken));

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("imagekit_not_configured");
  });
});
