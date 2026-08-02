import { HouseholdSchema, type Household } from "../schema/household.js";
import type { Sql, SqlExecutor } from "./client.js";

// The only module that knows SQL for household data. Everything above it sees the
// validated Household type from src/schema/household.ts — never a raw row.
//
// Note the `::text[]` casts on every read of allergies/dietary_flags: the columns are
// domain arrays (allergy_value[]), and postgres.js resolves result parsers by type
// OID, so it would hand back the raw `{gluten,soy}` string for an OID it doesn't
// know. Casting to text[] in the query keeps the driver's array parsing and costs
// nothing — the domain still enforces the vocabulary on write.

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
  allergies: string[];
  dietary_flags: string[];
  created_at: Date;
  updated_at: Date;
}

interface MemberRow {
  household_id: string;
  type: string;
  portion_factor: number;
  position: number;
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
      .map((member) => ({ type: member.type, portion_factor: member.portion_factor })),
    allergies: row.allergies,
    dietary_flags: row.dietary_flags,
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
    portion_factor: member.portion_factor,
    position,
  }));

  return sql<MemberRow[]>`
    insert into household_members ${sql(values)}
    returning household_id, type, portion_factor, position
  `;
}

/**
 * Persists a new household profile for an owner.
 *
 * The household and its members are written in one transaction: HouseholdSchema
 * requires at least one member, and that invariant spans two tables, so a partial
 * write would leave a row that fails validation on read.
 */
export async function createHousehold(
  sql: Sql,
  ownerUserId: string,
  input: Household,
): Promise<StoredHousehold> {
  const household = HouseholdSchema.parse(input);

  return sql.begin(async (tx) => {
    const [row] = await tx<HouseholdRow[]>`
      insert into households (owner_user_id, allergies, dietary_flags)
      values (
        ${ownerUserId},
        ${household.allergies}::text[]::allergy_value[],
        ${household.dietary_flags}::text[]::dietary_flag_value[]
      )
      returning
        id,
        owner_user_id,
        allergies::text[] as allergies,
        dietary_flags::text[] as dietary_flags,
        created_at,
        updated_at
    `;

    if (!row) throw new Error("insert into households returned no row");

    const memberRows = await insertMembers(tx, row.id, household);

    return toStoredHousehold(row, memberRows);
  }) as Promise<StoredHousehold>;
}

/** A household by id, or undefined when no such row is visible to this connection. */
export async function getHousehold(sql: Sql, id: string): Promise<StoredHousehold | undefined> {
  const [row] = await sql<HouseholdRow[]>`
    select
      id,
      owner_user_id,
      allergies::text[] as allergies,
      dietary_flags::text[] as dietary_flags,
      created_at,
      updated_at
    from households
    where id = ${id}
  `;

  if (!row) return undefined;

  const memberRows = await sql<MemberRow[]>`
    select household_id, type, portion_factor, position
    from household_members
    where household_id = ${id}
    order by position
  `;

  return toStoredHousehold(row, memberRows);
}

/**
 * Replaces a household's profile wholesale, returning undefined when no such row is
 * visible to this connection.
 *
 * Members are deleted and re-inserted rather than diffed: the profile is a small,
 * fully-authored value edited as a whole (UX_FLOW §6), so a diff would add moving
 * parts without changing what the user can express. `updated_at` is maintained by a
 * trigger, not written here.
 */
export async function updateHousehold(
  sql: Sql,
  id: string,
  input: Household,
): Promise<StoredHousehold | undefined> {
  const household = HouseholdSchema.parse(input);

  return sql.begin(async (tx) => {
    const [row] = await tx<HouseholdRow[]>`
      update households
      set allergies = ${household.allergies}::text[]::allergy_value[],
          dietary_flags = ${household.dietary_flags}::text[]::dietary_flag_value[]
      where id = ${id}
      returning
        id,
        owner_user_id,
        allergies::text[] as allergies,
        dietary_flags::text[] as dietary_flags,
        created_at,
        updated_at
    `;

    if (!row) return undefined;

    await tx`delete from household_members where household_id = ${id}`;
    const memberRows = await insertMembers(tx, id, household);

    return toStoredHousehold(row, memberRows);
  }) as Promise<StoredHousehold | undefined>;
}
