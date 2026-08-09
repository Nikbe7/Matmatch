import { afterAll, describe, expect, it } from "vitest";
import { HouseholdSchema } from "../schema/household.js";
import type { Sql } from "./client.js";
import { MissingUserContextError, withUserContext } from "./context.js";
import { createHousehold, getHousehold } from "./households.js";
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
  members: [{ type: "adult", portion_factor: 1, allergies: ["gluten"], dietary_flags: [] }],
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
    // Retargeted from `households` to `household_members` by #115: the allergy data
    // this proves is protected now lives on the member rows, and their policies are
    // defined by reference to the household's owner rather than by an owner column of
    // their own. Attacking the table that no longer holds the data would prove nothing.
    const alice = await createTestUser();
    const bob = await createTestUser();
    const bobHousehold = await createHousehold(sql!, bob.userId, profile);

    const updated = await withUserContext(
      sql!,
      alice.userId,
      (tx) => tx<{ household_id: string }[]>`
        update household_members set allergies = '{}'::text[]::allergy_value[]
        where household_id = ${bobHousehold.id}
        returning household_id
      `,
    );

    expect(updated).toEqual([]);
    // Bob's declared allergy is untouched — the dangerous direction is an attacker
    // *clearing* someone's allergies, so this asserts the value, not just the row count.
    const [row] = await admin!<{ allergies: string[] }[]>`
      select allergies::text[] as allergies
      from household_members where household_id = ${bobHousehold.id}
    `;
    expect(row!.allergies).toEqual(["gluten"]);
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
    expect(rows[0]!.allergies).toEqual(["gluten"]);
    expect(created.household.members[0]!.allergies).toEqual(["gluten"]);
  });

  it("has no default on the constraint columns, so an omitted allergy list errors instead of meaning none", async () => {
    const owner = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    // The safety property behind dropping the backfill defaults: a writer that forgets
    // these columns must fail loudly rather than silently record "no allergies".
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

    expect(columns.map((column) => column.column_name).sort()).toEqual([
      "created_at",
      "id",
      "owner_user_id",
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
