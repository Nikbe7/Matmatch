import type { Sql } from "./client.js";
import { withUserContext } from "./context.js";
import type { SubstitutionRef } from "./recipeInstructions.js";
import { buildSubstitutionKey } from "./recipeInstructions.js";

// The only module that knows SQL for cooked-meal history (issue #88).
//
// Unlike recipeInstructions.ts and like households.ts, every function here runs
// through withUserContext: these rows belong to a household, so the RLS policies added
// with the table apply and the request's user identity has to be in context. The
// household_id filtering in the queries below is therefore belt and braces — the
// queries say what they mean, and RLS independently guarantees a forgotten filter
// cannot widen the result set.
//
// History is append-only. There is no update or delete here, and the table grants none
// to the application role either (see the migration).

/** One cooked-meal row, as ranking consumes it. */
export interface CookedMeal {
  template_id: string;
  cooked_at: Date;
}

/**
 * A history row plus whether it falls on the current Swedish calendar day.
 *
 * `cooked_today` is computed in SQL against the same `cooked_on` the idempotency
 * constraint uses, rather than derived from `cooked_at` in JS: the two must agree on
 * where the day boundary is, and only the database knows that without this module
 * reimplementing timezone arithmetic. It rides along on the history query because the
 * penalty window always contains today — so the answer is already in the result set,
 * and asking for it separately would be a second round trip for a fact we just read.
 */
export interface RecentCookedMeal extends CookedMeal {
  cooked_today: boolean;
}

/**
 * Records that the household cooked `templateId` now, returning the stored row —
 * which, for a repeat tap on the same evening, is the row the *first* tap wrote.
 *
 * Idempotent by the table's `(household_id, template_id, cooked_on)` constraint rather
 * than by a preceding read: `on conflict do nothing` collapses a double tap atomically,
 * so two concurrent taps cannot both insert. Because DO NOTHING returns no row, the
 * conflicting row is read back explicitly — callers get a `cooked_at` either way and
 * never have to distinguish the two cases.
 *
 * `substitutions` is canonicalised by buildSubstitutionKey, the same function the
 * instructions cache keys on (DECISION_LOG 2026-08-05), so the stored array is
 * byte-identical for the same substitution set regardless of the order it arrived in.
 */
export async function recordCookedMeal(
  sql: Sql,
  userId: string,
  householdId: string,
  templateId: string,
  substitutions: readonly SubstitutionRef[],
): Promise<CookedMeal> {
  const substitutionKey = buildSubstitutionKey(substitutions);

  return withUserContext(sql, userId, async (tx) => {
    const [inserted] = await tx<CookedMeal[]>`
      insert into cooked_meals (household_id, template_id, substitution_key)
      values (${householdId}, ${templateId}, ${substitutionKey}::text[])
      on conflict (household_id, template_id, cooked_on) do nothing
      returning template_id, cooked_at
    `;
    if (inserted) return inserted;

    // The conflicting row, i.e. an earlier tap today. Scoped by household_id as well
    // as template_id so this cannot read another household's row even if RLS were
    // somehow inert.
    const [existing] = await tx<CookedMeal[]>`
      select template_id, cooked_at
      from cooked_meals
      where household_id = ${householdId}
        and template_id = ${templateId}
        and cooked_on = (now() at time zone 'Europe/Stockholm')::date
    `;

    if (!existing) {
      // Reachable only if the insert was rejected by something other than the day
      // constraint — a widened constraint, or the row disappearing between the two
      // statements. Loud rather than a fabricated timestamp.
      throw new Error(
        `cooked meal insert for template "${templateId}" neither inserted nor found an existing row`,
      );
    }

    return existing;
  });
}

/**
 * The household's cooked meals within the last `windowDays` days, newest first.
 *
 * `windowDays` is the ranking penalty window (`RECENCY_HISTORY_WINDOW_DAYS`), passed in
 * rather than known here: how far back history still affects an ordering is a ranking
 * decision, and this module has no business holding a second copy of it. Older rows are
 * left in the table — history is not pruned — they simply stop being loaded, which is
 * exactly what the window means: past it, a dish is back to full standing.
 */
export async function getRecentCookedMeals(
  sql: Sql,
  userId: string,
  householdId: string,
  windowDays: number,
): Promise<RecentCookedMeal[]> {
  return withUserContext(sql, userId, (tx) => tx<RecentCookedMeal[]>`
    select
      template_id,
      cooked_at,
      cooked_on = (now() at time zone 'Europe/Stockholm')::date as cooked_today
    from cooked_meals
    where household_id = ${householdId}
      and cooked_at > now() - make_interval(days => ${windowDays})
    order by cooked_at desc
  `);
}

/**
 * The templates this household cooked today, out of a history read.
 *
 * A set rather than a per-template query: the caller needs it for the one dish on the
 * card, but answering from rows already in memory keeps Tonight at a single history
 * round trip. Deliberately not exposed beyond that one boolean — a recent-history list
 * in the API would be surface for the history screen that is out of scope.
 */
export function cookedTodayTemplateIds(history: readonly RecentCookedMeal[]): Set<string> {
  return new Set(history.filter((row) => row.cooked_today).map((row) => row.template_id));
}
