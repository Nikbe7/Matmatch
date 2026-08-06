import type postgres from "postgres";
import type { Sql } from "./client.js";
import { withUserContext } from "./context.js";

// The only module that knows SQL for analytics event storage (issue #91).
//
// Like cooked_meals.ts and unlike recipeInstructions.ts: every row belongs to a
// household, so every function runs through withUserContext and the RLS policies
// added with the table apply. The household_id used in the insert is therefore
// belt and braces — RLS independently guarantees a request cannot write into a
// household it does not own.
//
// Append-only, same as cooked_meals: there is no update or delete here, and the
// table grants none to the application role either (see the migration).

/** One event as the route hands it in, already validated against the zod mirror. */
export interface AnalyticsEventInsert {
  name: string;
  payload: Record<string, postgres.JSONValue>;
  clientTimestamp: Date;
}

/**
 * Records a batch of analytics events for one household in a single statement.
 *
 * All-or-nothing: postgres.js's `sql(rows)` multi-row insert is one statement, so a
 * constraint violation on any row fails the whole batch rather than leaving a
 * partial write — matching the route's all-or-nothing validation (one bad event in
 * a batch rejects the batch before any insert is attempted).
 */
export async function recordAnalyticsEvents(
  sql: Sql,
  userId: string,
  householdId: string,
  events: readonly AnalyticsEventInsert[],
): Promise<void> {
  const rows = events.map((event) => ({
    household_id: householdId,
    event_name: event.name,
    payload: sql.json(event.payload),
    client_timestamp: event.clientTimestamp,
  }));

  await withUserContext(sql, userId, (tx) => tx`
    insert into analytics_events ${tx(rows)}
  `);
}
