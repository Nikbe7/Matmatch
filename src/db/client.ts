import postgres from "postgres";

// The only place a database connection is created. Household and meal data is
// reached exclusively through a plain Postgres client — never through the Supabase
// SDK, and never from a client-side caller (DECISION_LOG 2026-08-02, condition 2:
// the project's Data API is disabled, so the backend is the only path that exists).

export type Sql = postgres.Sql<Record<string, never>>;

/** Accepts either a pooled client or an open transaction, so repository helpers compose. */
export type SqlExecutor = Sql | postgres.TransactionSql<Record<string, never>>;

export interface DbConfig {
  connectionString: string;
  /** Cap on pooled connections. Small by default — this is a solo-scale backend. */
  max?: number;
}

export function createDbClient(config: DbConfig): Sql {
  return postgres(config.connectionString, {
    max: config.max ?? 5,
    // Fail fast rather than hanging a request when the database is unreachable. A
    // paused free-tier project (README, "Free-tier projects pause") surfaces here.
    connect_timeout: 10,
    // Column names are already snake_case in SQL and are mapped explicitly in the
    // repository, so no automatic transform is applied.
  });
}

/**
 * Reads the connection string from the environment. Kept separate from
 * createDbClient so tests can point at the local stack without touching process.env.
 */
export function connectionStringFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set — see .env.example and README.md");
  }
  return connectionString;
}
