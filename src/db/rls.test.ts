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
  members: [{ type: "adult", portion_factor: 1 }],
  allergies: ["gluten"],
  dietary_flags: [],
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

  it("cannot update another user's household even with a matching id", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const bobHousehold = await createHousehold(sql!, bob.userId, profile);

    const updated = await withUserContext(
      sql!,
      alice.userId,
      (tx) => tx<{ id: string }[]>`
        update households set dietary_flags = '{"vegan"}'::text[]::dietary_flag_value[]
        where id = ${bobHousehold.id}
        returning id
      `,
    );

    expect(updated).toEqual([]);
    const [row] = await admin!<{ dietary_flags: string[] }[]>`
      select dietary_flags::text[] as dietary_flags from households where id = ${bobHousehold.id}
    `;
    expect(row!.dietary_flags).toEqual([]);
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
