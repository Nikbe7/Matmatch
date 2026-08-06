import { afterAll, describe, expect, it } from "vitest";
import { HouseholdSchema } from "../schema/household.js";
import type { Sql } from "./client.js";
import { withUserContext } from "./context.js";
import { recordAnalyticsEvents } from "./analyticsEvents.js";
import { createHousehold } from "./households.js";
import {
  appClient,
  bypassClient,
  createTestUser,
  isLocalStackAvailable,
} from "./__fixtures__/localStack.js";

// analytics_events against the real local stack (issue #91). Nothing mocked, for the
// same reason as cooked_meals.test.ts/rls.test.ts: what matters here is exactly what
// a mock would paper over — RLS policies, and the fact that the app role has no
// UPDATE/DELETE on this table at all.

const stackAvailable = await isLocalStackAvailable();
const sql: Sql | undefined = stackAvailable ? appClient() : undefined;
const admin: Sql | undefined = stackAvailable ? bypassClient() : undefined;

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await admin?.end({ timeout: 5 });
});

const profile = HouseholdSchema.parse({
  members: [{ type: "adult", portion_factor: 1 }],
  allergies: [],
  dietary_flags: [],
});

async function newHousehold(): Promise<{ userId: string; householdId: string }> {
  const user = await createTestUser();
  const household = await createHousehold(sql!, user.userId, profile);
  return { userId: user.userId, householdId: household.id };
}

interface StoredRow {
  event_name: string;
  payload: Record<string, unknown>;
  client_timestamp: Date;
}

async function readHouseholdEvents(userId: string, householdId: string): Promise<StoredRow[]> {
  return withUserContext(sql!, userId, (tx) => tx<StoredRow[]>`
    select event_name, payload, client_timestamp
    from analytics_events
    where household_id = ${householdId}
    order by server_timestamp
  `);
}

describe.skipIf(!stackAvailable)("analytics_events repository (local Supabase)", () => {
  it("records a batch of events and reads them back", async () => {
    const { userId, householdId } = await newHousehold();
    const clientTimestamp = new Date("2026-08-05T18:00:00.000Z");

    await recordAnalyticsEvents(sql!, userId, householdId, [
      {
        name: "refinement_chip_tap",
        payload: { chip: "cheaper", weights: { cost: 1, time: 0 }, rerollDepth: 0 },
        clientTimestamp,
      },
      {
        name: "meal_cooked",
        payload: { templateId: "kycklinggryta", rerollDepth: 2 },
        clientTimestamp,
      },
    ]);

    const rows = await readHouseholdEvents(userId, householdId);
    expect(rows.map((row) => row.event_name)).toEqual(["refinement_chip_tap", "meal_cooked"]);
    expect(rows[0]!.payload).toEqual({ chip: "cheaper", weights: { cost: 1, time: 0 }, rerollDepth: 0 });
    expect(rows[0]!.client_timestamp.toISOString()).toBe(clientTimestamp.toISOString());
  });

  it("stores an event with an empty payload", async () => {
    const { userId, householdId } = await newHousehold();

    await recordAnalyticsEvents(sql!, userId, householdId, [
      {
        name: "refinement_session_abandoned",
        payload: { rerollDepth: 0 },
        clientTimestamp: new Date(),
      },
    ]);

    const rows = await readHouseholdEvents(userId, householdId);
    expect(rows).toHaveLength(1);
  });

  it("refuses to write without an authenticated user rather than writing uncontexted", async () => {
    const { householdId } = await newHousehold();

    await expect(
      recordAnalyticsEvents(sql!, "", householdId, [
        { name: "meal_cooked", payload: { templateId: "x", rerollDepth: 0 }, clientTimestamp: new Date() },
      ]),
    ).rejects.toThrow(/refusing to query without RLS context/i);
  });
});

describe.skipIf(!stackAvailable)("analytics_events row level security", () => {
  it("shows a household only its own events when the query has no household filter", async () => {
    const alice = await newHousehold();
    const bob = await newHousehold();
    await recordAnalyticsEvents(sql!, alice.userId, alice.householdId, [
      { name: "meal_cooked", payload: { templateId: "alices", rerollDepth: 0 }, clientTimestamp: new Date() },
    ]);
    await recordAnalyticsEvents(sql!, bob.userId, bob.householdId, [
      { name: "meal_cooked", payload: { templateId: "bobs", rerollDepth: 0 }, clientTimestamp: new Date() },
    ]);

    // Deliberately unfiltered: everything narrowing this result set is RLS.
    const visible = await withUserContext(sql!, alice.userId, (tx) => tx<{ event_name: string }[]>`
      select event_name from analytics_events
    `);

    expect(visible).toHaveLength(1);
  });

  it("cannot write events into another household", async () => {
    const alice = await newHousehold();
    const bob = await newHousehold();

    await expect(
      recordAnalyticsEvents(sql!, alice.userId, bob.householdId, [
        { name: "meal_cooked", payload: { templateId: "smuggled", rerollDepth: 0 }, clientTimestamp: new Date() },
      ]),
    ).rejects.toThrow(/row-level security/i);

    const [count] = await admin!<{ n: string }[]>`
      select count(*)::text as n from analytics_events where household_id = ${bob.householdId}
    `;
    expect(count!.n).toBe("0");
  });

  it("cannot rewrite or delete events at all — the app role has no UPDATE or DELETE", async () => {
    const owner = await newHousehold();
    await recordAnalyticsEvents(sql!, owner.userId, owner.householdId, [
      { name: "meal_cooked", payload: { templateId: "kycklinggryta", rerollDepth: 0 }, clientTimestamp: new Date() },
    ]);

    await expect(
      withUserContext(sql!, owner.userId, (tx) => tx`
        update analytics_events set event_name = 'annat' where household_id = ${owner.householdId}
      `),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withUserContext(sql!, owner.userId, (tx) => tx`
        delete from analytics_events where household_id = ${owner.householdId}
      `),
    ).rejects.toThrow(/permission denied/i);

    const [row] = await admin!<{ event_name: string }[]>`
      select event_name from analytics_events where household_id = ${owner.householdId}
    `;
    expect(row!.event_name).toBe("meal_cooked");
  });

  it("returns zero rows for a raw query with no RLS claim set", async () => {
    const owner = await newHousehold();
    await recordAnalyticsEvents(sql!, owner.userId, owner.householdId, [
      { name: "meal_cooked", payload: { templateId: "kycklinggryta", rerollDepth: 0 }, clientTimestamp: new Date() },
    ]);

    expect(await sql!<{ id: string }[]>`select id from analytics_events`).toEqual([]);
  });

  it("removes a household's events when the household itself is deleted", async () => {
    const owner = await newHousehold();
    await recordAnalyticsEvents(sql!, owner.userId, owner.householdId, [
      { name: "meal_cooked", payload: { templateId: "kycklinggryta", rerollDepth: 0 }, clientTimestamp: new Date() },
    ]);

    await withUserContext(sql!, owner.userId, (tx) => tx`
      delete from households where id = ${owner.householdId}
    `);

    const [count] = await admin!<{ n: string }[]>`
      select count(*)::text as n from analytics_events where household_id = ${owner.householdId}
    `;
    expect(count!.n).toBe("0");
  });
});
