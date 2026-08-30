import { HouseholdSchema, type Household } from "../schema/household.js";
import {
  PreferenceWeightsSchema,
  type PreferenceWeights,
} from "../schema/preferenceWeights.js";
import type { Sql, SqlExecutor } from "./client.js";
import { withUserContext } from "./context.js";

// The only module that knows SQL for household data. Everything above it sees the
// validated Household type from src/schema/household.ts — never a raw row.
//
// Every function runs through withUserContext, so each statement executes as
// matmatch_app with the request's user identity set as the RLS claim. The owner
// filtering below is therefore belt and braces: the queries say what they mean, and
// RLS independently guarantees a forgotten filter cannot widen the result set.
//
// Note the `::text[]` casts on every read of dietary_flags: the column is a domain
// array (dietary_flag_value[]), and postgres.js resolves result parsers by type
// OID, so it would hand back the raw `{gluten,soy}` string for an OID it doesn't
// know. Casting to text[] in the query keeps the driver's array parsing and costs
// nothing — the domain still enforces the vocabulary on write. Since #115 those
// columns live on household_members, so the casts moved with them; `households`
// itself now carries no profile columns at all, only ownership and timestamps.

/** A stored household: the in-memory profile plus the persistence-only fields. */
export interface StoredHousehold {
  id: string;
  owner_user_id: string;
  created_at: Date;
  updated_at: Date;
  household: Household;
  /**
   * The persistent preference baseline (#157).
   *
   * Deliberately a sibling of `household`, not a field inside it. `PUT /api/households`
   * is a full replacement with no version check (DECISION_LOG 2026-08-16), so an axis
   * living on `Household` would be silently reset to neutral by every profile save that
   * did not happen to send it — a household's sliders wiped by editing a member's name.
   * Keeping the baseline off the profile type makes that class of loss impossible:
   * `updateHousehold` cannot touch it, and `updateHouseholdPreferenceWeights` is the
   * only way it changes.
   */
  preference_weights: PreferenceWeights;
}

interface HouseholdRow {
  id: string;
  owner_user_id: string;
  created_at: Date;
  updated_at: Date;
  preference_price: number;
  preference_time: number;
  preference_variation: number;
  preference_simplicity: number;
}

/**
 * The column list every read of `households` uses, so no query can forget an axis and
 * silently hand back a partially-neutral baseline.
 *
 * `integer` round-trips through postgres.js as a JS number without a cast; the
 * `preference_weight` domain does not need the `::text[]` treatment the array domains
 * get, because the driver resolves int4 by OID already.
 */
const HOUSEHOLD_COLUMNS = [
  "id",
  "owner_user_id",
  "created_at",
  "updated_at",
  "preference_price",
  "preference_time",
  "preference_variation",
  "preference_simplicity",
] as const;

interface MemberRow {
  household_id: string;
  type: string;
  name: string | null;
  portion_factor: number;
  position: number;
  dietary_flags: string[];
}

/**
 * Builds a StoredHousehold from its rows, validating the profile through the same
 * zod schema the rest of the app uses.
 *
 * The row shape is never trusted blindly: a value that drifts from the locked
 * vocabularies (a hand-run SQL update, a future migration bug) fails here rather
 * than flowing into the Meal Engine, where an unrecognised dietary string would be
 * silently ignored by filtering instead of excluding anything.
 */
function toStoredHousehold(row: HouseholdRow, memberRows: readonly MemberRow[]): StoredHousehold {
  const household = HouseholdSchema.parse({
    members: [...memberRows]
      .sort((a, b) => a.position - b.position)
      .map((member) => ({
        type: member.type,
        // NULL is how "unnamed" is stored; the schema's optional `name` is how it is
        // expressed in memory. `?? undefined` is the whole translation — do not let a
        // null reach zod, which would reject it rather than treat it as absent.
        name: member.name ?? undefined,
        portion_factor: member.portion_factor,
        dietary_flags: member.dietary_flags,
      })),
  });

  return {
    id: row.id,
    owner_user_id: row.owner_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    household,
    // Validated on the way out for the same reason the profile is: the `preference_weight`
    // domain guards the range, but a hand-run UPDATE that predates the domain, or a future
    // migration bug, would otherwise flow straight into the score arithmetic. A weight the
    // schema rejects is a weight the engine must never see.
    preference_weights: PreferenceWeightsSchema.parse({
      price: row.preference_price,
      time: row.preference_time,
      variation: row.preference_variation,
      simplicity: row.preference_simplicity,
    }),
  };
}

async function insertMembers(
  sql: SqlExecutor,
  householdId: string,
  household: Household,
): Promise<MemberRow[]> {
  const values = household.members.map((member, position) => ({
    household_id: householdId,
    type: member.type,
    name: member.name ?? null,
    portion_factor: member.portion_factor,
    position,
    // Written as text[] and cast by the column's domain type on the way in, matching
    // how the household-level columns were written before #115.
    dietary_flags: member.dietary_flags,
    // #224 removed allergy filtering from the product but deliberately left the
    // column in place, so the branch reverts with `git revert` rather than a down
    // migration (DECISION_LOG 2026-08-25). The column is `not null` and its default
    // was dropped in 20260810000000 — on purpose, so that "nobody wrote an allergy
    // list" could never be silently recorded as "no allergies". That constraint is
    // still enforced, so the write path has to satisfy it: every member is written
    // with an empty list, which nothing reads. Remove this line only together with
    // the column itself.
    allergies: [] as string[],
  }));

  return sql<MemberRow[]>`
    insert into household_members ${sql(values)}
    returning
      household_id,
      type,
      name,
      portion_factor,
      position,
      dietary_flags::text[] as dietary_flags
  `;
}

/**
 * Persists a new household profile for the authenticated user, who becomes its owner.
 *
 * There is no parameter for creating a household on someone else's behalf: the owner
 * is the user in context, and the INSERT policy independently rejects any other value.
 *
 * The household and its members are written in one transaction: HouseholdSchema
 * requires at least one member, and that invariant spans two tables, so a partial
 * write would leave a row that fails validation on read.
 */
export async function createHousehold(
  sql: Sql,
  userId: string,
  input: Household,
): Promise<StoredHousehold> {
  const household = HouseholdSchema.parse(input);

  return withUserContext(sql, userId, async (tx) => {
    const [row] = await tx<HouseholdRow[]>`
      insert into households (owner_user_id)
      values (${userId})
      returning ${tx([...HOUSEHOLD_COLUMNS])}
    `;

    if (!row) throw new Error("insert into households returned no row");

    const memberRows = await insertMembers(tx, row.id, household);

    return toStoredHousehold(row, memberRows);
  });
}

/**
 * A household by id, or undefined when no such row is visible to this user.
 *
 * "Not yours" and "does not exist" deliberately look identical to the caller — the
 * row is invisible under RLS either way, and distinguishing them would leak which
 * household ids exist.
 */
export async function getHousehold(
  sql: Sql,
  userId: string,
  id: string,
): Promise<StoredHousehold | undefined> {
  return withUserContext(sql, userId, async (tx) => {
    const [row] = await tx<HouseholdRow[]>`
      select ${tx([...HOUSEHOLD_COLUMNS])}
      from households
      where id = ${id}
    `;

    if (!row) return undefined;

    const memberRows = await tx<MemberRow[]>`
      select
        household_id,
        type,
        name,
        portion_factor,
        position,
        dietary_flags::text[] as dietary_flags
      from household_members
      where household_id = ${id}
      order by position
    `;

    return toStoredHousehold(row, memberRows);
  });
}

/**
 * The authenticated user's own household, or undefined when they have none yet.
 *
 * Relies on the households_one_per_owner constraint (issue #56): under RLS the
 * unfiltered query below can only ever see rows owned by this user, and the
 * constraint guarantees there is at most one. If that constraint is ever relaxed for
 * the Phase 3 multi-household feature, this function's "one household" assumption
 * must be revisited alongside it — it is not a query-level LIMIT standing in for the
 * invariant, it *is* the invariant being relied on.
 */
export async function getHouseholdForOwner(
  sql: Sql,
  userId: string,
): Promise<StoredHousehold | undefined> {
  return withUserContext(sql, userId, async (tx) => {
    const [row] = await tx<HouseholdRow[]>`
      select ${tx([...HOUSEHOLD_COLUMNS])}
      from households
    `;

    if (!row) return undefined;

    const memberRows = await tx<MemberRow[]>`
      select
        household_id,
        type,
        name,
        portion_factor,
        position,
        dietary_flags::text[] as dietary_flags
      from household_members
      where household_id = ${row.id}
      order by position
    `;

    return toStoredHousehold(row, memberRows);
  });
}

/**
 * Replaces a household's profile wholesale, returning undefined when no such row is
 * visible to this user.
 *
 * Members are deleted and re-inserted rather than diffed: the profile is a small,
 * fully-authored value edited as a whole (UX_FLOW §6), so a diff would add moving
 * parts without changing what the user can express. `updated_at` is maintained by a
 * trigger, not written here.
 *
 * Since #115 the entire editable profile lives on the member rows, so the statement
 * against `households` below sets nothing — see its comment for why it is still an
 * UPDATE and not a SELECT.
 */
export async function updateHousehold(
  sql: Sql,
  userId: string,
  id: string,
  input: Household,
): Promise<StoredHousehold | undefined> {
  const household = HouseholdSchema.parse(input);

  return withUserContext(sql, userId, async (tx) => {
    // A deliberate no-op SET, not a leftover. `households` has no profile columns to
    // write since #115, but this must stay an UPDATE for two reasons a SELECT would
    // lose: it runs the RLS UPDATE policy's `using` *and* `with check` clauses (so an
    // edit is authorized as an edit, not merely as a read), and it fires the
    // households_set_updated_at trigger, which is what keeps `updated_at` meaning
    // "when this profile last changed" now that the change itself lands on the member
    // rows. Assigning owner_user_id to itself is the narrowest way to say that; it can
    // never alter the value, and the `with check` clause re-verifies it regardless.
    const [row] = await tx<HouseholdRow[]>`
      update households
      set owner_user_id = owner_user_id
      where id = ${id}
      returning ${tx([...HOUSEHOLD_COLUMNS])}
    `;

    if (!row) return undefined;

    await tx`delete from household_members where household_id = ${id}`;
    const memberRows = await insertMembers(tx, id, household);

    return toStoredHousehold(row, memberRows);
  });
}

/**
 * Replaces the household's preference baseline, returning undefined when no such row is
 * visible to this user.
 *
 * A separate entry point from `updateHousehold` rather than another field on it, for the
 * reason spelled out on `StoredHousehold.preference_weights`: the profile PUT is a full
 * replacement with no version check, so anything reachable through it is silently reset
 * by a client that does not send it. Sliders and member edits are also genuinely
 * different actions — one is a drag on Tonight, the other a form save on the profile —
 * and giving them one write path would mean either could clobber the other.
 *
 * Full replacement of all four axes, not a patch: the sliders are edited as a block, and
 * a partial write would make "what did this household ask for" depend on the order the
 * requests happened to arrive in.
 *
 * The UPDATE runs under the households_owner_update policy's `using` and `with check`
 * clauses, so a household id belonging to someone else matches no row and returns
 * undefined — indistinguishable from "does not exist", exactly as `getHousehold` is.
 */
export async function updateHouseholdPreferenceWeights(
  sql: Sql,
  userId: string,
  id: string,
  input: PreferenceWeights,
): Promise<StoredHousehold | undefined> {
  // Parsed before the statement, not only by the domain: a caller handing over 37 or
  // -10 gets a schema error naming the axis, rather than a raw Postgres domain violation
  // from three layers down. The domain still runs, and is what protects the table from
  // anything that bypasses this function.
  const weights = PreferenceWeightsSchema.parse(input);

  return withUserContext(sql, userId, async (tx) => {
    const [row] = await tx<HouseholdRow[]>`
      update households
      set preference_price = ${weights.price},
          preference_time = ${weights.time},
          preference_variation = ${weights.variation},
          preference_simplicity = ${weights.simplicity}
      where id = ${id}
      returning ${tx([...HOUSEHOLD_COLUMNS])}
    `;

    if (!row) return undefined;

    const memberRows = await tx<MemberRow[]>`
      select
        household_id,
        type,
        name,
        portion_factor,
        position,
        dietary_flags::text[] as dietary_flags
      from household_members
      where household_id = ${id}
      order by position
    `;

    return toStoredHousehold(row, memberRows);
  });
}
