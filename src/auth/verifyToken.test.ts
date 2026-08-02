import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LOCAL_ISSUER,
  LOCAL_JWKS_URL,
  createTestUser,
  isLocalStackAvailable,
} from "../db/__fixtures__/localStack.js";
import { AuthError, bearerToken, createTokenVerifier } from "./verifyToken.js";

const stackAvailable = await isLocalStackAvailable();

describe("bearerToken", () => {
  it("extracts the token from a well-formed header", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("throws when the header is absent", () => {
    expect(() => bearerToken(undefined)).toThrow(AuthError);
    expect(() => bearerToken("")).toThrow(AuthError);
  });

  it("throws when the header is not a Bearer token", () => {
    expect(() => bearerToken("Basic dXNlcjpwYXNz")).toThrow(AuthError);
    expect(() => bearerToken("Bearer")).toThrow(AuthError);
    expect(() => bearerToken("Bearer   ")).toThrow(AuthError);
  });
});

// A locally-generated ES256 key served from an in-process JWKS endpoint. Real GoTrue
// cannot mint an already-expired or wrong-issuer token on demand, so those cases are
// covered with a key we control — the verification path under test is identical.
describe("createTokenVerifier (controlled key)", () => {
  let server: Server;
  let jwksUrl: string;
  let signToken: (claims: Record<string, unknown>, expiry: string | number) => Promise<string>;
  let otherKeyToken: string;

  const ISSUER = "https://issuer.test/auth/v1";
  const AUDIENCE = "authenticated";
  const KID = "test-key";

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const jwk: JWK = { ...(await exportJWK(publicKey)), alg: "ES256", use: "sig", kid: KID };

    server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    jwksUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks.json`;

    signToken = (claims, expiry) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "ES256", kid: KID })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(expiry)
        .sign(privateKey);

    // Signed by a completely different key than the JWKS advertises.
    const stranger = await generateKeyPair("ES256", { extractable: true });
    otherKeyToken = await new SignJWT({ sub: "user-x" })
      .setProtectedHeader({ alg: "ES256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(stranger.privateKey);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const verifier = () =>
    createTokenVerifier({ jwksUrl, issuer: ISSUER, audience: AUDIENCE });

  it("returns the subject of a valid token", async () => {
    const token = await signToken({ sub: "user-123" }, "1h");

    await expect(verifier()(`Bearer ${token}`)).resolves.toEqual({ userId: "user-123" });
  });

  it("throws for an expired token", async () => {
    const token = await signToken({ sub: "user-123" }, Math.floor(Date.now() / 1000) - 60);

    await expect(verifier()(`Bearer ${token}`)).rejects.toThrow(AuthError);
  });

  it("throws for a token signed by an unknown key", async () => {
    await expect(verifier()(`Bearer ${otherKeyToken}`)).rejects.toThrow(AuthError);
  });

  it("throws for a token from the wrong issuer", async () => {
    const token = await new SignJWT({ sub: "user-123" })
      .setProtectedHeader({ alg: "ES256", kid: KID })
      .setIssuer("https://evil.test/auth/v1")
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign((await generateKeyPair("ES256", { extractable: true })).privateKey);

    await expect(verifier()(`Bearer ${token}`)).rejects.toThrow(AuthError);
  });

  it("throws for a token with no subject claim", async () => {
    const token = await signToken({}, "1h");

    await expect(verifier()(`Bearer ${token}`)).rejects.toThrow(/subject/i);
  });

  it("throws for a structurally invalid token", async () => {
    await expect(verifier()("Bearer not-a-jwt")).rejects.toThrow(AuthError);
  });

  it("throws when no Authorization header is supplied", async () => {
    await expect(verifier()(undefined)).rejects.toThrow(AuthError);
  });

  it("does not leak the underlying failure reason in the message", async () => {
    const token = await signToken({ sub: "user-123" }, Math.floor(Date.now() / 1000) - 60);

    await expect(verifier()(`Bearer ${token}`)).rejects.toThrow("invalid token");
  });
});

// The real thing: a token minted by the local stack's GoTrue, verified against the
// stack's published ES256 JWKS — the same asymmetric signing mode the cloud project
// uses (DECISION_LOG 2026-08-02, condition 3).
describe.skipIf(!stackAvailable)("createTokenVerifier (real Supabase token)", () => {
  it("verifies a genuine GoTrue token and returns its user id", async () => {
    const user = await createTestUser();
    const verify = createTokenVerifier({
      jwksUrl: LOCAL_JWKS_URL,
      issuer: LOCAL_ISSUER,
      audience: "authenticated",
    });

    await expect(verify(`Bearer ${user.accessToken}`)).resolves.toEqual({ userId: user.userId });
  });

  it("rejects a genuine token whose payload has been tampered with", async () => {
    const user = await createTestUser();
    const [header, , signature] = user.accessToken.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({
        iss: LOCAL_ISSUER,
        sub: crypto.randomUUID(),
        aud: "authenticated",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");

    const verify = createTokenVerifier({ jwksUrl: LOCAL_JWKS_URL, issuer: LOCAL_ISSUER });

    await expect(verify(`Bearer ${header}.${forgedPayload}.${signature}`)).rejects.toThrow(
      AuthError,
    );
  });

  it("rejects a genuine token when the expected issuer does not match", async () => {
    const user = await createTestUser();
    const verify = createTokenVerifier({
      jwksUrl: LOCAL_JWKS_URL,
      issuer: "https://some-other-project.supabase.co/auth/v1",
    });

    await expect(verify(`Bearer ${user.accessToken}`)).rejects.toThrow(AuthError);
  });
});
