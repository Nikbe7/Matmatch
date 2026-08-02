import { createRemoteJWKSet, jwtVerify } from "jose";

// Thin auth adapter (DECISION_LOG 2026-08-02, condition 3): a bearer token in, a
// user id out. Nothing else. It does not read user profiles, does not talk to the
// database, and deliberately does not use @supabase/supabase-js — the Supabase
// project signs JWTs asymmetrically (ES256), so verification is a standard JWKS
// check that `jose` performs locally, with no SDK and no per-request network call
// once the key set is cached.
//
// Keeping the surface this small is what bounds the cost of ever leaving Supabase:
// a different issuer means a different JWKS URL, not a rewrite of application code.

export class AuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuthError";
  }
}

export interface AuthenticatedUser {
  userId: string;
}

export interface TokenVerifierConfig {
  /** e.g. http://127.0.0.1:54321/auth/v1/.well-known/jwks.json */
  jwksUrl: string;
  /** Expected `iss`. Optional so the local stack's issuer can differ from the cloud project's. */
  issuer?: string;
  /** Expected `aud`. Supabase issues `authenticated` for signed-in users. */
  audience?: string;
}

export type TokenVerifier = (authorizationHeader: string | undefined) => Promise<AuthenticatedUser>;

/** Pulls the raw token out of an `Authorization: Bearer <token>` header. */
export function bearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader) throw new AuthError("missing Authorization header");

  const match = /^Bearer (.+)$/i.exec(authorizationHeader.trim());
  const token = match?.[1]?.trim();
  if (!token) throw new AuthError("Authorization header is not a Bearer token");

  return token;
}

/**
 * Builds a verifier bound to one JWKS endpoint.
 *
 * `createRemoteJWKSet` keeps the fetched key set in memory and refreshes it only
 * when an unknown key id appears (with its own cooldown), so this is one network
 * call at startup rather than one per request.
 */
export function createTokenVerifier(config: TokenVerifierConfig): TokenVerifier {
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl));

  return async (authorizationHeader) => {
    const token = bearerToken(authorizationHeader);

    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer,
        audience: config.audience,
      }));
    } catch (cause) {
      // Every failure mode — bad signature, expired, wrong issuer, malformed — is
      // reported the same way on purpose: the caller gets "not authenticated", not a
      // description of why, which would tell an attacker which part to fix.
      throw new AuthError("invalid token", { cause });
    }

    const userId = payload.sub;
    if (typeof userId !== "string" || userId.length === 0) {
      throw new AuthError("token has no subject claim");
    }

    return { userId };
  };
}

/** Reads verifier configuration from the environment. See .env.example. */
export function tokenVerifierConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TokenVerifierConfig {
  const jwksUrl = env.SUPABASE_JWKS_URL;
  if (!jwksUrl) {
    throw new Error("SUPABASE_JWKS_URL is not set — see .env.example and README.md");
  }

  return {
    jwksUrl,
    issuer: env.SUPABASE_JWT_ISSUER,
    audience: env.SUPABASE_JWT_AUDIENCE ?? "authenticated",
  };
}
