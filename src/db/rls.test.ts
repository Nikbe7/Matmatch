import { afterAll, describe, expect, it } from "vitest";
import { HouseholdSchema } from "../schema/household.js";
import type { Sql } from "./client.js";
import { createHousehold } from "./households.js";
import { backendClient, createTestUser, isLocalStackAvailable } from "./__fixtures__/localStack.js";

// RLS exercised for real, against the local stack.
//
// Two things make this test meaningful, and dropping either would make it pass
// vacuously:
//
//  1. It runs as the `authenticated` role, not the backend's own connection. The
//     backend connects as a superuser, which bypasses RLS entirely — a policy test on
//     that connection asserts nothing (proved explicitly by the last test below).
//  2. The tables carry explicit grants to `authenticated`, so a denial here is RLS
//     denying it, not a missing privilege.
//
// With the project's Data API disabled there is no PostgREST path to test through, so
// role switching plus request.jwt.claims is exactly how a direct database client would
// arrive — which is the threat model RLS is defense-in-depth against.

const stackAvailable = await isLocalStackAvailable();
const sql: Sql | undefined = stackAvailable ? backendClient() : undefined;

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

const profile = HouseholdSchema.parse({
  members: [{ type: "adult", portion_factor: 1 }],
  allergies: ["gluten"],
  dietary_flags: [],
});

/** Runs a query as `authenticated` with `sub` set to the given user id, as a JWT would. */
async function asUser<T>(userId: string, run: (tx: Sql) => Promise<T>): Promise<T> {
  return sql!.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
    await tx`set local role authenticated`;
    return run(tx as unknown as Sql);
  }) as Promise<T>;
}

async function asAnon<T>(run: (tx: Sql) => Promise<T>): Promise<T> {
  return sql!.begin(async (tx) => {
    await tx`set local role anon`;
    return run(tx as unknown as Sql);
  }) as Promise<T>;
}

describe.skipIf(!stackAvailable)("row level security", () => {
  it("lets an owner read their own household", async () => {
    const owner = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    const rows = await asUser(
      owner.userId,
      (tx) => tx<{ id: string }[]>`select id from households where id = ${created.id}`,
    );

    expect(rows.map((row) => row.id)).toEqual([created.id]);
  });

  it("hides a household from a different authenticated user", async () => {
    const owner = await createTestUser();
    const intruder = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    const rows = await asUser(
      intruder.userId,
      (tx) => tx<{ id: string }[]>`select id from households where id = ${created.id}`,
    );

    expect(rows).toEqual([]);
  });

  it("hides another user's household members", async () => {
    const owner = await createTestUser();
    const intruder = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    const ownerRows = await asUser(
      owner.userId,
      (tx) =>
        tx<{ id: string }[]>`select id from household_members where household_id = ${created.id}`,
    );
    const intruderRows = await asUser(
      intruder.userId,
      (tx) =>
        tx<{ id: string }[]>`select id from household_members where household_id = ${created.id}`,
    );

    expect(ownerRows).toHaveLength(1);
    expect(intruderRows).toEqual([]);
  });

  it("stops a user from updating another user's household", async () => {
    const owner = await createTestUser();
    const intruder = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    const updated = await asUser(
      intruder.userId,
      (tx) => tx<{ id: string }[]>`
        update households set dietary_flags = '{"vegan"}'::text[]::dietary_flag_value[]
        where id = ${created.id}
        returning id
      `,
    );

    expect(updated).toEqual([]);
    const [row] = await sql!<{ dietary_flags: string[] }[]>`
      select dietary_flags::text[] as dietary_flags from households where id = ${created.id}
    `;
    expect(row!.dietary_flags).toEqual([]);
  });

  it("stops a user from deleting another user's household", async () => {
    const owner = await createTestUser();
    const intruder = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    await asUser(intruder.userId, (tx) => tx`delete from households where id = ${created.id}`);

    const [row] = await sql!<{ id: string }[]>`select id from households where id = ${created.id}`;
    expect(row?.id).toBe(created.id);
  });

  it("stops a user from inserting a household owned by someone else", async () => {
    const owner = await createTestUser();
    const intruder = await createTestUser();

    await expect(
      asUser(
        intruder.userId,
        (tx) => tx`insert into households (owner_user_id) values (${owner.userId})`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("gives an unauthenticated (anon) connection no access at all", async () => {
    const owner = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    await expect(
      asAnon((tx) => tx`select id from households where id = ${created.id}`),
    ).rejects.toThrow(/permission denied/i);
  });

  // Documents the boundary of what RLS buys us, rather than leaving it implied.
  // FORCE ROW LEVEL SECURITY closes the table-owner bypass, but a superuser still
  // bypasses policies entirely — so RLS protects against a direct database client,
  // and does nothing against a bug in the backend itself. See DECISION_LOG 2026-08-02.
  it("does not constrain the backend's own superuser connection", async () => {
    const owner = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    const [row] = await sql!<{ id: string }[]>`select id from households where id = ${created.id}`;

    expect(row?.id).toBe(created.id);
  });
});
