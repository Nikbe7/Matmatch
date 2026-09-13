import { afterAll, describe, expect, it } from "vitest";
import { HouseholdSchema } from "../schema/household.js";
import type { Sql } from "./client.js";
import { withUserContext } from "./context.js";
import { readHouseholdEvents, recordAnalyticsEvents } from "./analyticsEvents.js";
import { createHousehold } from "./households.js";
import {
  appClient,
  bypassClient,
  createTestUser,
  isLocalStackAvailable,
} from "./__fixtures__/localStack.js";
import { makeHousehold } from "../engine/__fixtures__/household.js";

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

const profile = HouseholdSchema.parse(makeHousehold());

async function newHousehold(): Promise<{ userId: string; householdId: string }> {
  const user = await createTestUser();
  const household = await createHousehold(sql!, user.userId, profile);
  return { userId: user.userId, householdId: household.id };
}

/**
 * Writes one event in a transaction that is opened now and committed `delayMs` later, so
 * its `now()` — and therefore its server_timestamp — predates rows written in between.
 * Hand-rolled rather than going through recordAnalyticsEvents, which cannot hold a
 * transaction open on purpose, and should not learn how to.
 */
async function recordSlowly(
  userId: string,
  householdId: string,
  templateId: string,
  delayMs: number,
): Promise<void> {
  await withUserContext(sql!, userId, async (tx) => {
    await tx`select 1`;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await tx`
      insert into analytics_events (household_id, event_name, payload, client_timestamp)
      values (${householdId}, 'meal_chosen', ${tx.json({ templateId, rerollDepth: 0 })}, now())
    `;
  });
}

describe.skipIf(!stackAvailable)("analytics_events repository (local Supabase)", () => {
  it("records a batch of events and reads them back", async () => {
    const { userId, householdId } = await newHousehold();
    const clientTimestamp = new Date("2026-08-05T18:00:00.000Z");

    await recordAnalyticsEvents(sql!, userId, householdId, [
      {
        name: "refinement_chip_tap",
        payload: { chip: "cheaper", weights: { price: 1, time: 0 }, rerollDepth: 0 },
        clientTimestamp,
      },
      {
        name: "meal_chosen",
        payload: { templateId: "kycklinggryta", rerollDepth: 2 },
        clientTimestamp,
      },
    ]);

    // Order, not a set: the sequence is the property the #255 search-miss trail depends
    // on, and #103 deleted this assertion back when no reader needed it. Worth knowing
    // what this test does and does not prove — `order by server_timestamp` alone was
    // never *observably* wrong, it was *unspecified*, and an unspecified order coincides
    // with insert order most of the time on a small heap. That is why #103's version of
    // this passed for weeks and then failed every run with no code change in between.
    // What makes the order specified now is that seq holds a distinct value per row, so
    // no plan can answer it two ways; that invariant is asserted on its own below,
    // because it is the part a regression would actually break.
    const rows = await readHouseholdEvents(sql!, userId, householdId);
    expect(rows.map((row) => row.event_name)).toEqual(["refinement_chip_tap", "meal_chosen"]);

    const byName = new Map(rows.map((row) => [row.event_name, row]));
    expect(byName.get("refinement_chip_tap")!.payload).toEqual({
      chip: "cheaper",
      weights: { price: 1, time: 0 },
      rerollDepth: 0,
    });
    expect(byName.get("refinement_chip_tap")!.client_timestamp.toISOString()).toBe(
      clientTimestamp.toISOString(),
    );
    expect(byName.get("meal_chosen")!.payload).toEqual({
      templateId: "kycklinggryta",
      rerollDepth: 2,
    });
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

    const rows = await readHouseholdEvents(sql!, userId, householdId);
    expect(rows).toHaveLength(1);
  });

  it("assigns seq in insert order within a batch, and the same server_timestamp to all of it", async () => {
    const { userId, householdId } = await newHousehold();
    // The invariant the ordering rests on, asserted directly rather than sampled
    // through the reader. Ten rows in one statement, each carrying its own position in
    // the payload; read back ordered by seq alone, which is a unique column and so an
    // order no plan can vary. If seq ever stops following insert order — a plain
    // default, a sequence with a cache per session, a column swapped for something
    // non-monotonic — this is the test that fails.
    const sent = Array.from({ length: 10 }, (_, index) => ({
      name: "refinement_chip_tap",
      payload: { chip: "cheaper", weights: { price: 1, time: 0 }, rerollDepth: index },
      clientTimestamp: new Date("2026-09-13T18:00:00.000Z"),
    }));

    await recordAnalyticsEvents(sql!, userId, householdId, sent);

    // `seq_text`, not `seq`: ORDER BY resolves an output-column alias before a table
    // column, so `select seq::text as seq ... order by seq` sorts the *text* — which
    // puts 1000 before 995 and only misbehaves once the sequence crosses a digit-count
    // boundary. Carried as text because seq is a bigint, which the driver would
    // otherwise hand back as a string anyway.
    const rows = await withUserContext(sql!, userId, (tx) => tx<{ depth: number; seq_text: string; stamp: Date }[]>`
      select (payload->>'rerollDepth')::int as depth, seq::text as seq_text, server_timestamp as stamp
      from analytics_events
      where household_id = ${householdId}
      order by seq
    `);

    expect(rows.map((row) => row.depth)).toEqual([...Array(10).keys()]);
    // Strictly increasing, not contiguous: the sequence is shared, so a concurrent
    // writer legitimately takes values out of the middle. Monotonicity is the promise;
    // gaplessness is not, and asserting it would fail whenever a test ran alongside.
    const seqs = rows.map((row) => Number(row.seq_text));
    expect(seqs.every((value, index) => index === 0 || value > seqs[index - 1]!)).toBe(true);
    // And the tie it exists to break is genuinely there: one transaction, one `now()`.
    expect(new Set(rows.map((row) => row.stamp.toISOString())).size).toBe(1);
  });

  it("gives seq a distinct value per row while server_timestamp repeats, so the read order is total", async () => {
    const { userId, householdId } = await newHousehold();
    // Why the reader is deterministic at all: its sort key holds a distinct value per
    // row, so no tie is left for a plan or a heap layout to answer its own way.
    // server_timestamp is not that — three batches of two produce six rows and only
    // three timestamps, which is the bug #98 describes, asserted here so that the day
    // server_timestamp becomes per-row the reason this column exists is re-read rather
    // than assumed.
    for (let batch = 0; batch < 3; batch++) {
      await recordAnalyticsEvents(sql!, userId, householdId, [
        { name: "meal_chosen", payload: { templateId: `a${batch}`, rerollDepth: 0 }, clientTimestamp: new Date() },
        { name: "meal_chosen", payload: { templateId: `b${batch}`, rerollDepth: 0 }, clientTimestamp: new Date() },
      ]);
    }

    const [counts] = await withUserContext(sql!, userId, (tx) => tx<{ rows: number; seqs: number; stamps: number }[]>`
      select
        count(*)::int as rows,
        count(distinct seq)::int as seqs,
        count(distinct server_timestamp)::int as stamps
      from analytics_events
      where household_id = ${householdId}
    `);

    expect(counts!.rows).toBe(6);
    expect(counts!.seqs).toBe(6);
    expect(counts!.stamps).toBe(3);
  });

  it("reports two overlapping flushes in the order they were written, not the order they began", async () => {
    const { userId, householdId } = await newHousehold();
    // The reason the sort key is seq alone and not (server_timestamp, seq). A flush that
    // opens its transaction first but writes last carries the earlier server_timestamp —
    // `now()` is transaction start time — so any key led by that column reports it first
    // and inverts real write order. Two tabs, or a slow flush overlapping the next one,
    // is all it takes; #255's trail is exactly the reader that would be misled.
    const started = recordSlowly(userId, householdId, "began first, wrote second", 400);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await recordAnalyticsEvents(sql!, userId, householdId, [
      { name: "meal_chosen", payload: { templateId: "began second, wrote first", rerollDepth: 0 }, clientTimestamp: new Date() },
    ]);
    await started;

    const rows = await readHouseholdEvents(sql!, userId, householdId);
    expect(rows.map((row) => row.payload.templateId)).toEqual([
      "began second, wrote first",
      "began first, wrote second",
    ]);
    // And the inversion is genuinely present in the column, so this test is testing the
    // ordering choice rather than a timing coincidence: the row written second holds the
    // *earlier* server_timestamp.
    expect(rows[1]!.server_timestamp.getTime()).toBeLessThan(rows[0]!.server_timestamp.getTime());
  });

  it("orders later batches after earlier ones, not by which row the heap reaches first", async () => {
    const { userId, householdId } = await newHousehold();
    const at = (iso: string) => new Date(iso);

    // Three separate calls, so three transactions and three distinct server_timestamps.
    // client_timestamp deliberately descends while write order ascends: if the read
    // ever started ordering by the client's clock, this is the test that notices.
    await recordAnalyticsEvents(sql!, userId, householdId, [
      { name: "meal_chosen", payload: { templateId: "first", rerollDepth: 0 }, clientTimestamp: at("2026-09-13T20:00:00.000Z") },
    ]);
    await recordAnalyticsEvents(sql!, userId, householdId, [
      { name: "meal_chosen", payload: { templateId: "second", rerollDepth: 0 }, clientTimestamp: at("2026-09-13T19:00:00.000Z") },
    ]);
    await recordAnalyticsEvents(sql!, userId, householdId, [
      { name: "meal_chosen", payload: { templateId: "third", rerollDepth: 0 }, clientTimestamp: at("2026-09-13T18:00:00.000Z") },
    ]);

    const rows = await readHouseholdEvents(sql!, userId, householdId);
    expect(rows.map((row) => row.payload.templateId)).toEqual(["first", "second", "third"]);
  });

  it("refuses an application-supplied seq, so the app cannot disagree with the order", async () => {
    const { userId, householdId } = await newHousehold();

    // `generated always as identity`, not a default: the guarantee is that write order
    // is the database's to assign. A client that could name seq could reorder history.
    await expect(
      withUserContext(sql!, userId, (tx) => tx`
        insert into analytics_events (household_id, event_name, payload, client_timestamp, seq)
        values (${householdId}, 'meal_chosen', '{}'::jsonb, now(), 1)
      `),
    ).rejects.toThrow(/cannot insert a non-DEFAULT value into column/i);
  });

  it("refuses to write without an authenticated user rather than writing uncontexted", async () => {
    const { householdId } = await newHousehold();

    await expect(
      recordAnalyticsEvents(sql!, "", householdId, [
        { name: "meal_chosen", payload: { templateId: "x", rerollDepth: 0 }, clientTimestamp: new Date() },
      ]),
    ).rejects.toThrow(/refusing to query without RLS context/i);
  });
});

describe.skipIf(!stackAvailable)("analytics_events row level security", () => {
  it("shows a household only its own events when the query has no household filter", async () => {
    const alice = await newHousehold();
    const bob = await newHousehold();
    await recordAnalyticsEvents(sql!, alice.userId, alice.householdId, [
      { name: "meal_chosen", payload: { templateId: "alices", rerollDepth: 0 }, clientTimestamp: new Date() },
    ]);
    await recordAnalyticsEvents(sql!, bob.userId, bob.householdId, [
      { name: "meal_chosen", payload: { templateId: "bobs", rerollDepth: 0 }, clientTimestamp: new Date() },
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
        { name: "meal_chosen", payload: { templateId: "smuggled", rerollDepth: 0 }, clientTimestamp: new Date() },
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
      { name: "meal_chosen", payload: { templateId: "kycklinggryta", rerollDepth: 0 }, clientTimestamp: new Date() },
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
    expect(row!.event_name).toBe("meal_chosen");
  });

  it("returns zero rows for a raw query with no RLS claim set", async () => {
    const owner = await newHousehold();
    await recordAnalyticsEvents(sql!, owner.userId, owner.householdId, [
      { name: "meal_chosen", payload: { templateId: "kycklinggryta", rerollDepth: 0 }, clientTimestamp: new Date() },
    ]);

    expect(await sql!<{ id: string }[]>`select id from analytics_events`).toEqual([]);
  });

  it("removes a household's events when the household itself is deleted", async () => {
    const owner = await newHousehold();
    await recordAnalyticsEvents(sql!, owner.userId, owner.householdId, [
      { name: "meal_chosen", payload: { templateId: "kycklinggryta", rerollDepth: 0 }, clientTimestamp: new Date() },
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
