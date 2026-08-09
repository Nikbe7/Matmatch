import { HouseholdSchema, type Household } from "../schema/household.js";
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
// Note the `::text[]` casts on every read of allergies/dietary_flags: the columns are
// domain arrays (allergy_value[]), and postgres.js resolves result parsers by type
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
}

interface HouseholdRow {
  id: string;
  owner_user_id: string;
  created_at: Date;
  updated_at: Date;
}

interface MemberRow {
  household_id: string;
  type: string;
  name: string | null;
  portion_factor: number;
  position: number;
  allergies: string[];
  dietary_flags: string[];
}

/**
 * Builds a StoredHousehold from its rows, validating the profile through the same
 * zod schema the rest of the app uses.
 *
 * The row shape is never trusted blindly: a value that drifts from the locked
 * vocabularies (a hand-run SQL update, a future migration bug) fails here rather
 * than flowing into the Meal Engine, where an unrecognised allergy string would be
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
        allergies: member.allergies,
        dietary_flags: member.dietary_flags,
      })),
  });

  return {
    id: row.id,
    owner_user_id: row.owner_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    household,
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
    allergies: member.allergies,
    dietary_flags: member.dietary_flags,
  }));

  return sql<MemberRow[]>`
    insert into household_members ${sql(values)}
    returning
      household_id,
      type,
      name,
      portion_factor,
      position,
      allergies::text[] as allergies,
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
      returning id, owner_user_id, created_at, updated_at
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
      select id, owner_user_id, created_at, updated_at
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
        allergies::text[] as allergies,
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
      select id, owner_user_id, created_at, updated_at
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
        allergies::text[] as allergies,
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
      returning id, owner_user_id, created_at, updated_at
    `;

    if (!row) return undefined;

    await tx`delete from household_members where household_id = ${id}`;
    const memberRows = await insertMembers(tx, id, household);

    return toStoredHousehold(row, memberRows);
  });
}
