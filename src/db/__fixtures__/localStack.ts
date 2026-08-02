import { createDbClient, type Sql } from "../client.js";

// Helpers for tests that run against the real local Supabase stack (`supabase start`).
// Nothing here is mocked: the database tests exist precisely to catch what a mock
// would paper over — constraint violations, RLS behaviour, driver type handling.
//
// The values below are the Supabase CLI's fixed local defaults, identical on every
// machine and derived from a published dev key. They are not secrets and must never
// be confused with cloud project credentials, which live only in .env.

export const LOCAL_API_URL = "http://127.0.0.1:54321";
export const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
export const LOCAL_ISSUER = `${LOCAL_API_URL}/auth/v1`;
export const LOCAL_JWKS_URL = `${LOCAL_API_URL}/auth/v1/.well-known/jwks.json`;
export const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

/**
 * Whether the local stack is reachable. Database-backed suites skip themselves when
 * it isn't, so `npm test` still runs (covering less) on a machine without Docker.
 */
export async function isLocalStackAvailable(): Promise<boolean> {
  let sql: Sql | undefined;
  try {
    sql = createDbClient({ connectionString: LOCAL_DB_URL, max: 1 });
    await sql`select 1`;
    const response = await fetch(LOCAL_JWKS_URL);
    return response.ok;
  } catch {
    return false;
  } finally {
    await sql?.end({ timeout: 1 });
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

/** A pooled client connected as the default (superuser) role, as the backend would be. */
export function backendClient(): Sql {
  return createDbClient({ connectionString: LOCAL_DB_URL, max: 2 });
}
