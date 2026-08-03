import { createDbClient, type Sql } from "../client.js";

// Helpers for tests that run against the real local Supabase stack (`supabase start`).
// Nothing here is mocked: the database tests exist precisely to catch what a mock
// would paper over — constraint violations, RLS behaviour, driver type handling.
//
// The values below are the Supabase CLI's fixed local defaults plus the throwaway
// application-role password from supabase/seed.sql. They are identical on every
// machine, are never pushed to the cloud project, and must not be confused with cloud
// credentials, which live only in .env.

export const LOCAL_API_URL = "http://127.0.0.1:54321";
export const LOCAL_ISSUER = `${LOCAL_API_URL}/auth/v1`;
export const LOCAL_JWKS_URL = `${LOCAL_API_URL}/auth/v1/.well-known/jwks.json`;
export const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

/** What the backend itself connects as: least privilege, no RLS bypass. */
export const APP_DB_URL = "postgresql://matmatch_app:matmatch_local_dev@127.0.0.1:54322/postgres";

/**
 * The `postgres` role, which carries rolbypassrls. Test-setup only — creating fixture
 * rows the app role could not create for another user, and asserting the bypass still
 * exists. No application code path may use this.
 */
export const BYPASS_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Whether the local stack is reachable *and* the application role can authenticate.
 * Database-backed suites skip themselves when it isn't, so `npm test` still runs
 * (covering less) on a machine without Docker.
 */
export async function isLocalStackAvailable(): Promise<boolean> {
  let app: Sql | undefined;
  let bypass: Sql | undefined;
  try {
    app = createDbClient({ connectionString: APP_DB_URL, max: 1 });
    bypass = createDbClient({ connectionString: BYPASS_DB_URL, max: 1 });
    await app`select 1`;
    await bypass`select 1`;
    const response = await fetch(LOCAL_JWKS_URL);
    return response.ok;
  } catch {
    return false;
  } finally {
    await app?.end({ timeout: 1 });
    await bypass?.end({ timeout: 1 });
  }
}

export interface TestUser {
  userId: string;
  accessToken: string;
}

/**
 * Creates a real user through GoTrue and returns its id plus a genuine ES256 access
 * token — the same signing path the cloud project uses, so the auth adapter is
 * exercised against real tokens rather than hand-rolled ones.
 */
export async function createTestUser(): Promise<TestUser> {
  const email = `test-${crypto.randomUUID()}@example.com`;

  const response = await fetch(`${LOCAL_API_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: LOCAL_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: `pw-${crypto.randomUUID()}` }),
  });

  if (!response.ok) {
    throw new Error(`signup failed: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as {
    access_token?: string;
    user?: { id?: string };
  };

  if (!body.access_token || !body.user?.id) {
    throw new Error(`signup returned no session: ${JSON.stringify(body)}`);
  }

  return { userId: body.user.id, accessToken: body.access_token };
}

/** A pooled client connected as the application role — what the backend uses. */
export function appClient(): Sql {
  return createDbClient({ connectionString: APP_DB_URL, max: 2 });
}

/** A pooled client that bypasses RLS. Test setup and bypass assertions only. */
export function bypassClient(): Sql {
  return createDbClient({ connectionString: BYPASS_DB_URL, max: 2 });
}
