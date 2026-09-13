import { afterAll, describe, expect, it } from "vitest";
import { HouseholdSchema } from "../schema/household.js";
import type { Sql } from "./client.js";
import { MissingUserContextError, withUserContext } from "./context.js";
import {
  createHousehold,
  getHousehold,
  getHouseholdForOwner,
  updateHouseholdPreferenceWeights,
} from "./households.js";
import {
  appClient,
  bypassClient,
  createTestUser,
  isLocalStackAvailable,
} from "./__fixtures__/localStack.js";

// RLS exercised for real, against the local stack.
//
// Since #53 this is the suite that proves RLS is load-bearing rather than decorative.
// The backend connects as `matmatch_app`, which has no rolbypassrls, so the policies
// apply to its queries once the request's user is set as the RLS claim. What makes
// these tests meaningful:
//
//  1. `sql` is the real application role, the same connection the backend uses — not
//     a simulated one via SET ROLE.
//  2. The isolation tests below query *without an owner filter in the SQL*, so a pass
//     can only come from RLS. A WHERE clause would prove nothing.
//  3. `admin` (rolbypassrls) is used only to plant another user's data and to assert
//     the bypass still exists as a known property of Postgres.

const stackAvailable = await isLocalStackAvailable();
const sql: Sql | undefined = stackAvailable ? appClient() : undefined;
const admin: Sql | undefined = stackAvailable ? bypassClient() : undefined;

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await admin?.end({ timeout: 5 });
});

const profile = HouseholdSchema.parse({
  members: [{ type: "adult", portion_factor: 1, dietary_flags: ["vegetarian"] }],
});

describe.skipIf(!stackAvailable)("row level security — application role", () => {
  it("shows a user only their own household when the query has no owner filter", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const aliceHousehold = await createHousehold(sql!, alice.userId, profile);
    const bobHousehold = await createHousehold(sql!, bob.userId, profile);

    // Deliberately unfiltered: `select ... from households` with no WHERE at all.
    // Everything narrowing this result set is RLS.
    const visible = await withUserContext(
      sql!,
      alice.userId,
      (tx) => tx<{ id: string }[]>`select id from households`,
    );

    expect(visible.map((row) => row.id)).toEqual([aliceHousehold.id]);
    expect(visible.map((row) => row.id)).not.toContain(bobHousehold.id);
  });

  it("shows a user only their own household members when the query has no owner filter", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    await createHousehold(sql!, alice.userId, profile);
    await createHousehold(sql!, bob.userId, profile);

    const visible = await withUserContext(
      sql!,
      alice.userId,
      (tx) => tx<{ household_id: string }[]>`select household_id from household_members`,
    );

    const householdIds = new Set(visible.map((row) => row.household_id));
    expect(householdIds.size).toBe(1);
  });

  it("cannot read another user's household through the repository", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const bobHousehold = await createHousehold(sql!, bob.userId, profile);

    expect(await getHousehold(sql!, alice.userId, bobHousehold.id)).toBeUndefined();
    // ...and Bob still can, so this is scoping rather than a broken read path.
    expect(await getHousehold(sql!, bob.userId, bobHousehold.id)).toBeDefined();
  });

  it("cannot edit another user's member constraints even with a matching household id", async () => {
    // Retargeted from `households` to `household_members` by #115: the constraint data
    // this proves is protected lives on the member rows, and their policies are
    // defined by reference to the household's owner rather than by an owner column of
    // their own. Attacking the table that no longer holds the data would prove nothing.
    //
    // #224 retargeted the *column* for the same reason. This used to attack
    // `allergies`, which the repository now writes as an unread empty list — an attack
    // on a column holding nothing for everyone would pass whether RLS worked or not.
    // `dietary_flags` is the constraint data a household actually has, so it is what
    // the policy has to be demonstrated on.
    const alice = await createTestUser();
    const bob = await createTestUser();
    const bobHousehold = await createHousehold(sql!, bob.userId, profile);

    const updated = await withUserContext(
      sql!,
      alice.userId,
      (tx) => tx<{ household_id: string }[]>`
        update household_members set dietary_flags = '{}'::text[]::dietary_flag_value[]
        where household_id = ${bobHousehold.id}
        returning household_id
      `,
    );

    expect(updated).toEqual([]);
    // Bob's declared flag is untouched — the dangerous direction is an attacker
    // *clearing* someone's constraints, so this asserts the value, not just the row
    // count.
    const [row] = await admin!<{ dietary_flags: string[] }[]>`
      select dietary_flags::text[] as dietary_flags
      from household_members where household_id = ${bobHousehold.id}
    `;
    expect(row!.dietary_flags).toEqual(["vegetarian"]);
  });

  // Preference weights (#157) — the same owner-scoped policies, asserted for the new
  // columns rather than assumed. They carry no allergy data, so the danger is different
  // from the member-constraint case above: one household silently steering another's
  // suggestions, and one household reading what another has asked for.
  it("cannot read another user's preference weights through an unfiltered query", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const bobHousehold = await createHousehold(sql!, bob.userId, profile);
    await updateHouseholdPreferenceWeights(sql!, bob.userId, bobHousehold.id, {
      price: 100,
      time: 55,
      variation: 20,
      simplicity: 5,
    });

    // No WHERE clause at all: everything narrowing this is RLS.
    const visible = await withUserContext(
      sql!,
      alice.userId,
      (tx) => tx<{ id: string; preference_price: number }[]>`
        select id, preference_price from households
      `,
    );

    expect(visible.map((row) => row.id)).not.toContain(bobHousehold.id);
    // ...and Bob still sees his own, so this is scoping rather than a broken read path.
    expect(
      (await getHouseholdForOwner(sql!, bob.userId))!.preference_weights.price,
    ).toBe(100);
  });

  it("cannot read another user's preference weights through the repository", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const bobHousehold = await createHousehold(sql!, bob.userId, profile);

    expect(await getHousehold(sql!, alice.userId, bobHousehold.id)).toBeUndefined();
  });

  it("cannot write another user's preference weights, even with a matching household id", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const bobHousehold = await createHousehold(sql!, bob.userId, profile);
    await updateHouseholdPreferenceWeights(sql!, bob.userId, bobHousehold.id, {
      price: 100,
      time: 0,
      variation: 0,
      simplicity: 0,
    });

    // Through the repository...
    expect(
      await updateHouseholdPreferenceWeights(sql!, alice.userId, bobHousehold.id, {
        price: 0,
        time: 0,
        variation: 0,
        simplicity: 0,
      }),
    ).toBeUndefined();

    // ...and through raw SQL that skips it entirely.
    const updated = await withUserContext(
      sql!,
      alice.userId,
      (tx) => tx<{ id: string }[]>`
        update households set preference_price = 0 where id = ${bobHousehold.id} returning id
      `,
    );
    expect(updated).toEqual([]);

    // Asserted on the value, not just the row count: the failure that matters is Bob's
    // stated preference being silently rewritten by someone else.
    const [row] = await admin!<{ preference_price: number }[]>`
      select preference_price from households where id = ${bobHousehold.id}
    `;
    expect(row!.preference_price).toBe(100);
  });

  it("cannot delete another user's household", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const bobHousehold = await createHousehold(sql!, bob.userId, profile);

    await withUserContext(
      sql!,
      alice.userId,
      (tx) => tx`delete from households where id = ${bobHousehold.id}`,
    );

    const [row] = await admin!<{ id: string }[]>`
      select id from households where id = ${bobHousehold.id}
    `;
    expect(row?.id).toBe(bobHousehold.id);
  });

  it("cannot insert a household owned by someone else", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();

    await expect(
      withUserContext(
        sql!,
        alice.userId,
        (tx) => tx`insert into households (owner_user_id) values (${bob.userId})`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe.skipIf(!stackAvailable)("row level security — fail closed without context", () => {
  it("throws rather than querying when no user id is supplied", async () => {
    await expect(getHousehold(sql!, "", crypto.randomUUID())).rejects.toThrow(
      MissingUserContextError,
    );
    await expect(getHousehold(sql!, "   ", crypto.randomUUID())).rejects.toThrow(
      MissingUserContextError,
    );
  });

  // The guard above is the application layer. This is the database layer, proven
  // independently: even if the guard were removed, an uncontexted query sees nothing.
  it("returns zero rows for a raw query with no RLS claim set", async () => {
    const owner = await createTestUser();
    await createHousehold(sql!, owner.userId, profile);

    const rows = await sql!<{ id: string }[]>`select id from households`;

    expect(rows).toEqual([]);
  });

  it("returns zero rows when the claim names a user with no households", async () => {
    const owner = await createTestUser();
    await createHousehold(sql!, owner.userId, profile);

    const rows = await withUserContext(
      sql!,
      crypto.randomUUID(),
      (tx) => tx<{ id: string }[]>`select id from households`,
    );

    expect(rows).toEqual([]);
  });
});

describe.skipIf(!stackAvailable)("RLS context is transaction-scoped", () => {
  it("does not leak the claim to later queries on the same pooled connection", async () => {
    // One connection in the pool, so the next query is guaranteed to reuse the
    // connection the transaction ran on — which is exactly the leak being ruled out.
    const single = appClient();
    try {
      const owner = await createTestUser();
      const created = await createHousehold(single, owner.userId, profile);

      const inside = await withUserContext(
        single,
        owner.userId,
        (tx) => tx<{ id: string }[]>`select id from households`,
      );
      expect(inside.map((row) => row.id)).toEqual([created.id]);

      // Same connection, after the transaction committed: the claim must be gone.
      const [claim] = await single<{ claims: string }[]>`
        select current_setting('request.jwt.claims', true) as claims
      `;
      const after = await single<{ id: string }[]>`select id from households`;

      expect(claim?.claims ?? "").toBe("");
      expect(after).toEqual([]);
    } finally {
      await single.end({ timeout: 5 });
    }
  });

  it("does not leak the claim after a failed transaction", async () => {
    const single = appClient();
    try {
      const owner = await createTestUser();
      await createHousehold(single, owner.userId, profile);

      await expect(
        withUserContext(single, owner.userId, async (tx) => {
          await tx`select 1`;
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      const after = await single<{ id: string }[]>`select id from households`;
      expect(after).toEqual([]);
    } finally {
      await single.end({ timeout: 5 });
    }
  });
});

describe.skipIf(!stackAvailable)("application role privileges", () => {
  it("cannot create tables", async () => {
    await expect(sql!`create table public.evil (id int)`).rejects.toThrow(/permission denied/i);
  });

  it("cannot drop or alter the tables it reads", async () => {
    await expect(sql!`drop table public.households`).rejects.toThrow(/must be owner/i);
    await expect(sql!`alter table public.households add column sneaky text`).rejects.toThrow(
      /must be owner/i,
    );
  });

  it("cannot disable row level security on the tables it reads", async () => {
    await expect(sql!`alter table public.households disable row level security`).rejects.toThrow(
      /must be owner/i,
    );
  });

  it("cannot read tables it was never granted", async () => {
    await expect(sql!`select id from auth.users`).rejects.toThrow(/permission denied/i);
  });

  it("cannot call auth.uid() directly, though policies using it still work", async () => {
    // The role has no USAGE on schema auth — deliberately. A policy expression is not
    // subject to the caller's schema privileges, which is why owner scoping still
    // resolves. Pinned here so that if this ever changes it fails loudly rather than
    // silently widening or breaking access.
    await expect(sql!`select auth.uid()`).rejects.toThrow(/permission denied/i);

    const owner = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);
    expect((await getHousehold(sql!, owner.userId, created.id))?.id).toBe(created.id);
  });

  it("carries neither superuser nor the RLS bypass attribute", async () => {
    const [row] = await admin!<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = 'matmatch_app'
    `;

    expect(row).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });
});

// Client-role privileges on the public schema (#267). TRUNCATE is the reason this
// suite exists: it is NOT subject to row level security, so policies never see it and
// every append-only guarantee in this schema was scoped to DELETE without covering it.
// Asserted against the live catalog rather than read off the migration, per the
// DECISION_LOG 2026-08-07 rule quoted above — hosted Supabase and the local stack do
// not agree on bootstrap defaults, so the post-migration state is the only thing worth
// asserting.
describe.skipIf(!stackAvailable)("client roles hold nothing on public beyond what was granted (#267)", () => {
  // What each migration explicitly granted `authenticated`, and nothing else. A table
  // absent from this map must hold nothing at all: the four backend-owned tables
  // (dish_generation_attempts, generated_dishes, ingredient_review_queue,
  // recipe_instructions) are reached only through matmatch_app.
  const INTENDED = new Map<string, string[]>([
    ["households", ["SELECT", "INSERT", "UPDATE", "DELETE"]],
    ["household_members", ["SELECT", "INSERT", "UPDATE", "DELETE"]],
    ["cooked_meals", ["SELECT", "INSERT"]],
    ["analytics_events", ["SELECT", "INSERT"]],
  ]);

  it("grants anon and service_role nothing whatsoever on any table in public", async () => {
    const rows = await admin!<{ table_name: string; grantee: string; privilege_type: string }[]>`
      select table_name, grantee, privilege_type
      from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('anon', 'service_role')
      order by table_name, grantee, privilege_type
    `;

    expect(rows).toEqual([]);
  });

  it("grants authenticated exactly the privileges its migrations asked for, per table", async () => {
    const rows = await admin!<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type
      from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'authenticated'
      order by table_name, privilege_type
    `;

    const actual = new Map<string, string[]>();
    for (const row of rows) {
      actual.set(row.table_name, [...(actual.get(row.table_name) ?? []), row.privilege_type]);
    }

    expect([...actual.keys()].sort()).toEqual([...INTENDED.keys()].sort());
    for (const [table, privileges] of INTENDED) {
      expect([table, actual.get(table)?.sort()]).toEqual([table, [...privileges].sort()]);
    }
  });

  it("lets no client role truncate a table, which RLS would not have stopped", async () => {
    // Spelled out separately from the sweep above because it is the whole point: a
    // policy cannot refuse a TRUNCATE, so this privilege is the one that turns
    // "append-only" into a claim the database does not back.
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const table of ["analytics_events", "cooked_meals", "households"]) {
        const [row] = await admin!<{ allowed: boolean }[]>`
          select has_table_privilege(${role}, ${`public.${table}`}, 'TRUNCATE') as allowed
        `;
        expect([role, table, row!.allowed]).toEqual([role, table, false]);
      }
    }
  });

  it("gives no client role setval on a sequence, which would undo #98's read order", async () => {
    // `UPDATE` on a sequence is setval. analytics_events.seq is what gives that table a
    // read order, and the unique index on (household_id, seq desc) is what makes the
    // order total — so winding the sequence back would either reintroduce the ties #98
    // removed or break the analytics write path against that index.
    const rows = await admin!<{ grantee: string; privilege_type: string }[]>`
      select grantee, privilege_type
      from information_schema.role_usage_grants
      where object_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role')
    `;
    expect(rows).toEqual([]);

    const [seq] = await admin!<{ name: string }[]>`
      select pg_get_serial_sequence('public.analytics_events', 'seq') as name
    `;
    for (const role of ["anon", "authenticated", "service_role"]) {
      const [row] = await admin!<{ allowed: boolean }[]>`
        select has_sequence_privilege(${role}, ${seq!.name}, 'UPDATE') as allowed
      `;
      expect([role, row!.allowed]).toEqual([role, false]);
    }
  });

  it("hands a newly created table no client-role privileges, so the fix covers tables not yet written", async () => {
    // The half that makes #267 stick. The revokes only reached tables that existed when
    // the migration ran; the grants came from ALTER DEFAULT PRIVILEGES, which would have
    // re-applied them to every table added afterwards. Created as `postgres` because
    // that is the role migrations run as, and default privileges are per creating role.
    const name = `zz_grant_probe_${Date.now()}`;
    try {
      await admin!.unsafe(`create table public.${name} (id int)`);
      const rows = await admin!<{ grantee: string; privilege_type: string }[]>`
        select grantee, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and table_name = ${name}
          and grantee in ('anon', 'authenticated', 'service_role')
      `;
      expect(rows).toEqual([]);
    } finally {
      await admin!.unsafe(`drop table if exists public.${name}`);
    }
  });
});

// Kept, not deleted: this remains true of Postgres and is the reason the application
// role exists. Note the mechanism is `rolbypassrls`, NOT superuser — the `postgres`
// role here is not a superuser (rolsuper is false), which is worth stating because
// looking for a superuser that doesn't exist is a dead end. No application code path
// may use this connection.
// #115 moved allergies and dietary_flags onto household_members. DECISION_LOG
// 2026-08-07: never take a security-relevant table property from a *default* or from
// reasoning about grant inheritance — hosted Supabase and the local stack do not
// agree on those defaults, and the failure is silent (an unfiltered select simply
// returns nothing). These assert the post-migration state directly.
describe.skipIf(!stackAvailable)("per-member constraint columns are reachable and protected (#115)", () => {
  it("keeps RLS enabled and forced on household_members after the migration", async () => {
    const [row] = await admin!<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity
      from pg_class
      where oid = 'public.household_members'::regclass
    `;

    expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("lets the application role read the new columns — the grant is table-wide, verified not assumed", async () => {
    const owner = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    // Unfiltered on purpose, as everywhere else in this file: RLS is what narrows it.
    // A missing column grant would surface here as an error, and a missing policy as
    // an empty array — the exact silent signature of the 2026-08-07 bug.
    const rows = await withUserContext(
      sql!,
      owner.userId,
      (tx) => tx<{ allergies: string[]; dietary_flags: string[]; name: string | null }[]>`
        select allergies::text[] as allergies, dietary_flags::text[] as dietary_flags, name
        from household_members
      `,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.dietary_flags).toEqual(["vegetarian"]);
    expect(created.household.members[0]!.dietary_flags).toEqual(["vegetarian"]);
    // `allergies` is still selected above on purpose: the column outlived the feature
    // (#224) and the grant is what this test is about. Nothing reads its value any
    // more, and the repository writes every member an empty list to satisfy the
    // column's `not null` — asserted here because no other test can see that write.
    expect(rows[0]!.allergies).toEqual([]);
  });

  it("has no default on the constraint columns, so an omitted list errors instead of meaning none", async () => {
    const owner = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    // The safety property behind dropping the backfill defaults: a writer that forgets
    // these columns must fail loudly rather than silently record "nothing declared".
    // Still enforced after #224, and still load-bearing for `dietary_flags` — it is
    // also why `insertMembers` has to keep writing the now-unread `allergies` column.
    await expect(
      admin!`
        insert into household_members (household_id, type, portion_factor, position)
        values (${created.id}, 'adult', 1, 50)
      `,
    ).rejects.toThrow(/null value in column "(allergies|dietary_flags)"/i);
  });

  it("no longer has household-level constraint columns to drift from the member rows", async () => {
    const columns = await admin!<{ column_name: string }[]>`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'households'
    `;

    // An exact list rather than a "does not contain allergies" assertion, so a future
    // migration that reintroduces a household-level safety column fails here. The four
    // preference_* columns arrived with #157 and are ranking-only — they are listed
    // because this assertion is exhaustive, not because they are constraint data.
    expect(columns.map((column) => column.column_name).sort()).toEqual([
      "created_at",
      "id",
      "owner_user_id",
      "preference_price",
      "preference_simplicity",
      "preference_time",
      "preference_variation",
      "updated_at",
    ]);
  });
});

describe.skipIf(!stackAvailable)("a rolbypassrls connection still bypasses RLS", () => {
  it("reads any household regardless of policies, which is why it is not the app role", async () => {
    const owner = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    const [row] = await admin!<{ id: string }[]>`
      select id from households where id = ${created.id}
    `;
    expect(row?.id).toBe(created.id);

    const [attributes] = await admin!<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = current_user
    `;
    expect(attributes).toMatchObject({ rolsuper: false, rolbypassrls: true });
  });
});
