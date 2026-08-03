import { afterAll, describe, expect, it } from "vitest";
import { HouseholdSchema, type Household } from "../schema/household.js";
import type { Sql } from "./client.js";
import { createHousehold, getHousehold, updateHousehold } from "./households.js";
import {
  appClient,
  bypassClient,
  createTestUser,
  isLocalStackAvailable,
} from "./__fixtures__/localStack.js";

// Runs against the real local Supabase stack — not mocked. A mock would assert that
// this file's own SQL strings are what this file expects, which proves nothing about
// the constraints, domains and driver type handling that actually protect the data.
//
// `sql` is the application role, exactly what the backend connects as. `admin`
// bypasses RLS and is used only where a test needs to prove something *other* than
// RLS: the schema constraints below have to be reached without a policy rejecting the
// write first, or they would never be exercised at all.

const stackAvailable = await isLocalStackAvailable();
const sql: Sql | undefined = stackAvailable ? appClient() : undefined;
const admin: Sql | undefined = stackAvailable ? bypassClient() : undefined;

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await admin?.end({ timeout: 5 });
});

const profile: Household = HouseholdSchema.parse({
  members: [
    { type: "adult", portion_factor: 1 },
    { type: "adult", portion_factor: 0.9 },
    { type: "child", portion_factor: 0.6 },
  ],
  allergies: ["gluten", "fish"],
  dietary_flags: ["vegetarian"],
});

describe.skipIf(!stackAvailable)("households repository (local Supabase)", () => {
  it("round-trips a household profile through the database", async () => {
    const owner = await createTestUser();

    const created = await createHousehold(sql!, owner.userId, profile);
    const read = await getHousehold(sql!, owner.userId, created.id);

    expect(read).toBeDefined();
    expect(read!.owner_user_id).toBe(owner.userId);
    // Re-validating proves the row can reconstruct a legal profile, not just that the
    // strings survived the trip.
    expect(HouseholdSchema.safeParse(read!.household).success).toBe(true);
    expect(read!.household).toEqual(profile);
  });

  it("preserves member order across the round trip", async () => {
    const owner = await createTestUser();
    const ordered = HouseholdSchema.parse({
      members: [
        { type: "child", portion_factor: 0.5 },
        { type: "adult", portion_factor: 1 },
        { type: "child", portion_factor: 0.7 },
      ],
      allergies: [],
      dietary_flags: [],
    });

    const created = await createHousehold(sql!, owner.userId, ordered);
    const read = await getHousehold(sql!, owner.userId, created.id);

    expect(read!.household.members).toEqual(ordered.members);
  });

  it("stores an empty allergy and dietary list without turning it into null", async () => {
    const owner = await createTestUser();
    const plain = HouseholdSchema.parse({
      members: [{ type: "adult", portion_factor: 1 }],
      allergies: [],
      dietary_flags: [],
    });

    const created = await createHousehold(sql!, owner.userId, plain);

    expect(created.household.allergies).toEqual([]);
    expect((await getHousehold(sql!, owner.userId, created.id))!.household.dietary_flags).toEqual([]);
  });

  it("replaces members, allergies and flags on update", async () => {
    const owner = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    const revised = HouseholdSchema.parse({
      members: [{ type: "adult", portion_factor: 1.2 }],
      allergies: ["soy"],
      dietary_flags: ["vegan", "vegetarian"],
    });
    const updated = await updateHousehold(sql!, owner.userId, created.id, revised);

    expect(updated!.household).toEqual(revised);
    expect((await getHousehold(sql!, owner.userId, created.id))!.household).toEqual(revised);
    expect(updated!.id).toBe(created.id);
  });

  it("bumps updated_at on update via the trigger, leaving created_at alone", async () => {
    const owner = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    const updated = await updateHousehold(sql!, owner.userId, created.id, {
      ...profile,
      allergies: ["egg"],
    });

    expect(updated!.created_at.getTime()).toBe(created.created_at.getTime());
    expect(updated!.updated_at.getTime()).toBeGreaterThanOrEqual(created.updated_at.getTime());
  });

  it("returns undefined for an id that does not exist", async () => {
    const owner = await createTestUser();

    expect(await getHousehold(sql!, owner.userId, crypto.randomUUID())).toBeUndefined();
    expect(await updateHousehold(sql!, owner.userId, crypto.randomUUID(), profile)).toBeUndefined();
  });

  it("cascades member deletion when a household is deleted", async () => {
    const owner = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    await admin!`delete from households where id = ${created.id}`;
    const [row] = await admin!<{ count: string }[]>`
      select count(*)::text as count from household_members where household_id = ${created.id}
    `;

    expect(row?.count).toBe("0");
  });

  it("rejects an invalid profile before it reaches the database", async () => {
    const owner = await createTestUser();

    await expect(
      createHousehold(sql!, owner.userId, { members: [], allergies: [], dietary_flags: [] }),
    ).rejects.toThrow();
  });
});

// The database must reject bad data on its own, independently of zod — these bypass
// the repository entirely and write raw SQL, because a constraint that only zod
// enforces is not a constraint.
describe.skipIf(!stackAvailable)("households schema constraints (raw SQL)", () => {
  it("rejects an allergen outside the locked §5.2 vocabulary", async () => {
    const owner = await createTestUser();

    await expect(
      admin!`
        insert into households (owner_user_id, allergies)
        values (${owner.userId}, '{"sesame"}'::text[]::allergy_value[])
      `,
    ).rejects.toThrow(/allergy_value/i);
  });

  it("rejects a dietary flag outside the locked vocabulary", async () => {
    const owner = await createTestUser();

    await expect(
      admin!`
        insert into households (owner_user_id, dietary_flags)
        values (${owner.userId}, '{"pescatarian"}'::text[]::dietary_flag_value[])
      `,
    ).rejects.toThrow(/dietary_flag_value/i);
  });

  it("rejects duplicate allergies", async () => {
    const owner = await createTestUser();

    await expect(
      admin!`
        insert into households (owner_user_id, allergies)
        values (${owner.userId}, '{"gluten","gluten"}'::text[]::allergy_value[])
      `,
    ).rejects.toThrow(/no_duplicates/i);
  });

  it("rejects a non-positive portion_factor", async () => {
    const owner = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    await expect(
      admin!`
        insert into household_members (household_id, type, portion_factor, position)
        values (${created.id}, 'adult', 0, 99)
      `,
    ).rejects.toThrow(/portion_factor/i);
  });

  it("rejects a member type outside adult/child", async () => {
    const owner = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    await expect(
      admin!`
        insert into household_members (household_id, type, portion_factor, position)
        values (${created.id}, 'teenager', 1, 98)
      `,
    ).rejects.toThrow(/type/i);
  });

  it("rejects a household whose owner is not a real auth user", async () => {
    await expect(
      admin!`insert into households (owner_user_id) values (${crypto.randomUUID()})`,
    ).rejects.toThrow(/owner_user_id_fkey/i);
  });
});
