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

// Since #115 constraints hang off individual members, so the fixture spreads the
// same set the household used to carry across the people who actually have them —
// the union is still {gluten, fish} / {vegetarian}, which is what keeps every
// engine-facing expectation in the suite unchanged.
const profile: Household = HouseholdSchema.parse({
  members: [
    { type: "adult", name: "Ella", portion_factor: 1, allergies: ["gluten"], dietary_flags: ["vegetarian"] },
    { type: "adult", portion_factor: 0.9, allergies: [], dietary_flags: [] },
    { type: "child", portion_factor: 0.6, allergies: ["fish"], dietary_flags: [] },
  ],
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
        { type: "child", portion_factor: 0.5, allergies: [], dietary_flags: [] },
        { type: "adult", portion_factor: 1, allergies: [], dietary_flags: [] },
        { type: "child", portion_factor: 0.7, allergies: [], dietary_flags: [] },
      ],
    });

    const created = await createHousehold(sql!, owner.userId, ordered);
    const read = await getHousehold(sql!, owner.userId, created.id);

    expect(read!.household.members).toEqual(ordered.members);
  });

  it("stores an empty allergy and dietary list without turning it into null", async () => {
    const owner = await createTestUser();
    const plain = HouseholdSchema.parse({
      members: [{ type: "adult", portion_factor: 1, allergies: [], dietary_flags: [] }],
    });

    const created = await createHousehold(sql!, owner.userId, plain);
    const read = await getHousehold(sql!, owner.userId, created.id);

    expect(created.household.members[0]!.allergies).toEqual([]);
    expect(read!.household.members[0]!.dietary_flags).toEqual([]);
  });

  it("keeps each member's constraints on that member rather than merging them", async () => {
    const owner = await createTestUser();

    const created = await createHousehold(sql!, owner.userId, profile);
    const read = await getHousehold(sql!, owner.userId, created.id);

    // The whole point of #115: after the round trip it is still recoverable *whose*
    // allergy each one is. A union-shaped store cannot answer this.
    expect(read!.household.members.map((member) => member.allergies)).toEqual([
      ["gluten"],
      [],
      ["fish"],
    ]);
    expect(read!.household.members.map((member) => member.dietary_flags)).toEqual([
      ["vegetarian"],
      [],
      [],
    ]);
  });

  it("round-trips an optional member name, and stores an unnamed member as absent rather than empty", async () => {
    const owner = await createTestUser();

    const created = await createHousehold(sql!, owner.userId, profile);
    const read = await getHousehold(sql!, owner.userId, created.id);

    expect(read!.household.members[0]!.name).toBe("Ella");
    // NULL in the column becomes `undefined`, never "" — the two must not be
    // distinguishable downstream, or the label fallback would render a blank chip.
    expect(read!.household.members[1]!.name).toBeUndefined();
  });

  it("replaces members and their constraints on update", async () => {
    const owner = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    const revised = HouseholdSchema.parse({
      members: [
        { type: "adult", portion_factor: 1.2, allergies: ["soy"], dietary_flags: ["vegan", "vegetarian"] },
      ],
    });
    const updated = await updateHousehold(sql!, owner.userId, created.id, revised);

    expect(updated!.household).toEqual(revised);
    expect((await getHousehold(sql!, owner.userId, created.id))!.household).toEqual(revised);
    expect(updated!.id).toBe(created.id);
  });

  it("bumps updated_at on update via the trigger, leaving created_at alone", async () => {
    const owner = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    // The trigger must still fire even though the UPDATE against `households` sets
    // nothing since #115 — the profile change lands entirely on the member rows.
    const updated = await updateHousehold(sql!, owner.userId, created.id, {
      members: [{ ...profile.members[0]!, allergies: ["egg"] }],
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
      createHousehold(sql!, owner.userId, { members: [] }),
    ).rejects.toThrow();
  });
});

// The database must reject bad data on its own, independently of zod — these bypass
// the repository entirely and write raw SQL, because a constraint that only zod
// enforces is not a constraint.
describe.skipIf(!stackAvailable)("households schema constraints (raw SQL)", () => {
  it("rejects an allergen outside the locked §5.2 vocabulary", async () => {
    const owner = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    await expect(
      admin!`
        insert into household_members (household_id, type, portion_factor, position, allergies, dietary_flags)
        values (${created.id}, 'adult', 1, 97, '{"sesame"}'::text[]::allergy_value[], '{}')
      `,
    ).rejects.toThrow(/allergy_value/i);
  });

  it("rejects a dietary flag outside the locked vocabulary", async () => {
    const owner = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    await expect(
      admin!`
        insert into household_members (household_id, type, portion_factor, position, allergies, dietary_flags)
        values (${created.id}, 'adult', 1, 96, '{}', '{"pescatarian"}'::text[]::dietary_flag_value[])
      `,
    ).rejects.toThrow(/dietary_flag_value/i);
  });

  it("rejects duplicate allergies", async () => {
    const owner = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    await expect(
      admin!`
        insert into household_members (household_id, type, portion_factor, position, allergies, dietary_flags)
        values (${created.id}, 'adult', 1, 95, '{"gluten","gluten"}'::text[]::allergy_value[], '{}')
      `,
    ).rejects.toThrow(/no_duplicates/i);
  });

  it("rejects a non-positive portion_factor", async () => {
    const owner = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    await expect(
      admin!`
        insert into household_members (household_id, type, portion_factor, position, allergies, dietary_flags)
        values (${created.id}, 'adult', 0, 99, '{}', '{}')
      `,
    ).rejects.toThrow(/portion_factor/i);
  });

  it("rejects a member type outside adult/child", async () => {
    const owner = await createTestUser();
    const created = await createHousehold(sql!, owner.userId, profile);

    await expect(
      admin!`
        insert into household_members (household_id, type, portion_factor, position, allergies, dietary_flags)
        values (${created.id}, 'teenager', 1, 98, '{}', '{}')
      `,
    ).rejects.toThrow(/type/i);
  });

  it("rejects a household whose owner is not a real auth user", async () => {
    await expect(
      admin!`insert into households (owner_user_id) values (${crypto.randomUUID()})`,
    ).rejects.toThrow(/owner_user_id_fkey/i);
  });
});
