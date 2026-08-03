import type { Sql, SqlExecutor } from "./client.js";

// Per-request RLS context (issue #53).
//
// The backend connects as `matmatch_app`, which has no RLS bypass, so the household
// policies apply to its queries — but only once the request's user identity is set
// as the claim those policies read. This module is the single place that happens:
// centralising it means a repository function cannot forget it, and cannot set it
// with the wrong scope.

/** Thrown when a data access is attempted without an authenticated user. */
export class MissingUserContextError extends Error {
  constructor() {
    super("no authenticated user id supplied — refusing to query without RLS context");
    this.name = "MissingUserContextError";
  }
}

/**
 * Runs `fn` in a transaction with the authenticated user's id set as the RLS claim.
 *
 * The claim is set with `set_config(..., true)` — **transaction-scoped**. That is
 * load-bearing, not a detail: connections are pooled and reused across requests, and
 * a session-scoped setting would leak one user's identity into the next request that
 * happened to get the same connection. Postgres discards it at commit or rollback.
 *
 * Fails closed by throwing on a missing user id rather than querying without context.
 * The database would also deny it (policies compare against a null `auth.uid()`, so
 * reads return zero rows), but a silent empty result reads as "no such household" —
 * the caller would answer 404 and the bug would stay hidden. Both layers are tested
 * independently in rls.test.ts.
 */
export async function withUserContext<T>(
  sql: Sql,
  userId: string,
  fn: (tx: SqlExecutor) => Promise<T>,
): Promise<T> {
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new MissingUserContextError();
  }

  // postgres.js types `begin` as returning UnwrapPromiseArray<T>, which widens T for
  // array-shaped results. The cast is confined to this one function rather than
  // repeated at every call site.
  return sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({
      sub: userId,
      role: "authenticated",
    })}, true)`;

    return fn(tx);
  }) as Promise<T>;
}
