import { afterAll, describe, expect, it } from "vitest";
import { HouseholdSchema } from "../schema/household.js";
import type { Sql } from "./client.js";
import { withUserContext } from "./context.js";
import {
  cookedTodayTemplateIds,
  getRecentCookedMeals,
  recordCookedMeal,
} from "./cookedMeals.js";
import { createHousehold } from "./households.js";
import {
  appClient,
  bypassClient,
  createTestUser,
  isLocalStackAvailable,
} from "./__fixtures__/localStack.js";

// cooked_meals against the real local stack (issue #88). Nothing mocked, for the same
// reason as households.test.ts/rls.test.ts: what matters here is exactly what a mock
// would paper over — the day-scoped unique constraint that makes a double tap
// idempotent, the RLS policies, and the fact that the app role has no UPDATE/DELETE on
// this table at all.
//
// `admin` (rolbypassrls) is used only to plant backdated rows — the application role
// cannot rewrite history by design, so the window tests cannot set up through it.

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

/** A fresh owner with a household, so no test depends on another's rows. */
async function newHousehold(): Promise<{ userId: string; householdId: string }> {
  const user = await createTestUser();
  const household = await createHousehold(sql!, user.userId, profile);
  return { userId: user.userId, householdId: household.id };
}

/** Plants a row at an arbitrary time in the past, which the app role cannot do itself. */
async function plantCookedMeal(householdId: string, templateId: string, daysAgo: number) {
  await admin!`
    insert into cooked_meals (household_id, template_id, cooked_at, cooked_on)
    values (
      ${householdId},
      ${templateId},
      now() - make_interval(days => ${daysAgo}),
      ((now() - make_interval(days => ${daysAgo})) at time zone 'Europe/Stockholm')::date
    )
  `;
}

describe.skipIf(!stackAvailable)("cooked_meals repository (local Supabase)", () => {
  it("records a cooked meal and reads it back as history", async () => {
    const { userId, householdId } = await newHousehold();

    const cooked = await recordCookedMeal(sql!, userId, householdId, "kycklinggryta", []);

    expect(cooked.template_id).toBe("kycklinggryta");
    expect(cooked.cooked_at).toBeInstanceOf(Date);

    const history = await getRecentCookedMeals(sql!, userId, householdId, 14);
    expect(history.map((row) => row.template_id)).toEqual(["kycklinggryta"]);
  });

  it("collapses a double tap on the same evening into one row, returning the first timestamp", async () => {
    const { userId, householdId } = await newHousehold();

    const first = await recordCookedMeal(sql!, userId, householdId, "kycklinggryta", []);
    const second = await recordCookedMeal(sql!, userId, householdId, "kycklinggryta", []);

    // Same row, not a second one: the caller cannot tell the two calls apart, which is
    // the point — a retry is never an error and never a duplicate.
    expect(second.cooked_at.getTime()).toBe(first.cooked_at.getTime());

    const [count] = await admin!<{ n: string }[]>`
      select count(*)::text as n from cooked_meals where household_id = ${householdId}
    `;
    expect(count!.n).toBe("1");
  });

  it("records two different dishes cooked on the same day as two rows", async () => {
    const { userId, householdId } = await newHousehold();

    await recordCookedMeal(sql!, userId, householdId, "kycklinggryta", []);
    await recordCookedMeal(sql!, userId, householdId, "fisksoppa", []);

    const history = await getRecentCookedMeals(sql!, userId, householdId, 14);
    expect(new Set(history.map((row) => row.template_id))).toEqual(
      new Set(["kycklinggryta", "fisksoppa"]),
    );
  });

  it("stores the substitution set in the canonical buildSubstitutionKey form", async () => {
    const { userId, householdId } = await newHousehold();

    // Deliberately out of slot order on the way in.
    await recordCookedMeal(sql!, userId, householdId, "kycklinggryta", [
      { slot_index: 2, substitute_ingredient_id: "tofu" },
      { slot_index: 0, substitute_ingredient_id: "havredryck" },
    ]);

    const [row] = await withUserContext(sql!, userId, (tx) => tx<{ substitution_key: string[] }[]>`
      select substitution_key from cooked_meals where household_id = ${householdId}
    `);

    expect(row!.substitution_key).toEqual(["0:havredryck", "2:tofu"]);
  });

  it("defaults substitution_key to an empty array for an unsubstituted meal", async () => {
    const { userId, householdId } = await newHousehold();

    await recordCookedMeal(sql!, userId, householdId, "kycklinggryta", []);

    const [row] = await withUserContext(sql!, userId, (tx) => tx<{ substitution_key: string[] }[]>`
      select substitution_key from cooked_meals where household_id = ${householdId}
    `);

    expect(row!.substitution_key).toEqual([]);
  });

  it("returns history newest first", async () => {
    const { userId, householdId } = await newHousehold();
    await plantCookedMeal(householdId, "old", 9);
    await plantCookedMeal(householdId, "recent", 2);

    const history = await getRecentCookedMeals(sql!, userId, householdId, 14);

    expect(history.map((row) => row.template_id)).toEqual(["recent", "old"]);
  });

  it("excludes rows older than the requested window without deleting them", async () => {
    const { userId, householdId } = await newHousehold();
    await plantCookedMeal(householdId, "inside-window", 13);
    await plantCookedMeal(householdId, "outside-window", 20);

    const history = await getRecentCookedMeals(sql!, userId, householdId, 14);
    expect(history.map((row) => row.template_id)).toEqual(["inside-window"]);

    // Still on disk — the window bounds what ranking loads, it does not prune history.
    const [count] = await admin!<{ n: string }[]>`
      select count(*)::text as n from cooked_meals where household_id = ${householdId}
    `;
    expect(count!.n).toBe("2");
  });

  it("flags only today's rows as cooked_today, leaving older ones in the history", async () => {
    const { userId, householdId } = await newHousehold();
    await recordCookedMeal(sql!, userId, householdId, "kycklinggryta", []);
    await plantCookedMeal(householdId, "fisksoppa", 3);

    const history = await getRecentCookedMeals(sql!, userId, householdId, 14);
    const today = cookedTodayTemplateIds(history);

    expect(today.has("kycklinggryta")).toBe(true);
    expect(today.has("fisksoppa")).toBe(false);
    expect(today.has("aldrig-lagad")).toBe(false);
    // The older row is still history — it just isn't today's.
    expect(history.map((row) => row.template_id).sort()).toEqual(["fisksoppa", "kycklinggryta"]);
  });

  it("treats a meal cooked just before midnight as yesterday, matching the constraint's day", async () => {
    // The day boundary that decides cooked_today is the same Swedish calendar day the
    // idempotency constraint uses — computed in SQL, never re-derived in JS.
    const { userId, householdId } = await newHousehold();
    await admin!`
      insert into cooked_meals (household_id, template_id, cooked_at, cooked_on)
      values (
        ${householdId},
        'igar-kvall',
        now() - interval '1 day',
        ((now() - interval '1 day') at time zone 'Europe/Stockholm')::date
      )
    `;

    const history = await getRecentCookedMeals(sql!, userId, householdId, 14);

    expect(history).toHaveLength(1);
    expect(cookedTodayTemplateIds(history).has("igar-kvall")).toBe(false);
  });

  it("refuses to query without an authenticated user rather than reading uncontexted", async () => {
    const { householdId } = await newHousehold();

    await expect(getRecentCookedMeals(sql!, "", householdId, 14)).rejects.toThrow(
      /refusing to query without RLS context/i,
    );
    await expect(recordCookedMeal(sql!, "  ", householdId, "kycklinggryta", [])).rejects.toThrow(
      /refusing to query without RLS context/i,
    );
  });
});

describe.skipIf(!stackAvailable)("cooked_meals row level security", () => {
  it("shows a household only its own history when the query has no household filter", async () => {
    const alice = await newHousehold();
    const bob = await newHousehold();
    await recordCookedMeal(sql!, alice.userId, alice.householdId, "alices-ratt", []);
    await recordCookedMeal(sql!, bob.userId, bob.householdId, "bobs-ratt", []);

    // Deliberately unfiltered: everything narrowing this result set is RLS.
    const visible = await withUserContext(sql!, alice.userId, (tx) => tx<{ template_id: string }[]>`
      select template_id from cooked_meals
    `);

    expect(visible.map((row) => row.template_id)).toEqual(["alices-ratt"]);
  });

  it("cannot read another household's history through the repository", async () => {
    const alice = await newHousehold();
    const bob = await newHousehold();
    await recordCookedMeal(sql!, bob.userId, bob.householdId, "bobs-ratt", []);

    // Alice's user id against Bob's household id — the shape a scoping bug would take.
    expect(await getRecentCookedMeals(sql!, alice.userId, bob.householdId, 14)).toEqual([]);

    // ...and Bob still can, so this is scoping rather than a broken read path.
    const bobsHistory = await getRecentCookedMeals(sql!, bob.userId, bob.householdId, 14);
    expect(cookedTodayTemplateIds(bobsHistory).has("bobs-ratt")).toBe(true);
  });

  it("cannot write history into another household", async () => {
    const alice = await newHousehold();
    const bob = await newHousehold();

    await expect(
      recordCookedMeal(sql!, alice.userId, bob.householdId, "smuggled", []),
    ).rejects.toThrow(/row-level security/i);

    const [count] = await admin!<{ n: string }[]>`
      select count(*)::text as n from cooked_meals where household_id = ${bob.householdId}
    `;
    expect(count!.n).toBe("0");
  });

  it("cannot rewrite or delete history at all — the app role has no UPDATE or DELETE", async () => {
    const owner = await newHousehold();
    await recordCookedMeal(sql!, owner.userId, owner.householdId, "kycklinggryta", []);

    // Not "zero rows affected": the grant itself is absent, so this fails loudly. Its own
    // history included — history is append-only for every household, not just other ones.
    await expect(
      withUserContext(sql!, owner.userId, (tx) => tx`
        update cooked_meals set template_id = 'annat' where household_id = ${owner.householdId}
      `),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withUserContext(sql!, owner.userId, (tx) => tx`
        delete from cooked_meals where household_id = ${owner.householdId}
      `),
    ).rejects.toThrow(/permission denied/i);

    const [row] = await admin!<{ template_id: string }[]>`
      select template_id from cooked_meals where household_id = ${owner.householdId}
    `;
    expect(row!.template_id).toBe("kycklinggryta");
  });

  it("returns zero rows for a raw query with no RLS claim set", async () => {
    const owner = await newHousehold();
    await recordCookedMeal(sql!, owner.userId, owner.householdId, "kycklinggryta", []);

    expect(await sql!<{ id: string }[]>`select id from cooked_meals`).toEqual([]);
  });

  it("removes a household's history when the household itself is deleted", async () => {
    // The FK cascade runs as the table owner, so it works despite the app role having no
    // DELETE on cooked_meals — worth pinning, since the alternative (a blocked cascade)
    // would make deleting a household fail outright.
    const owner = await newHousehold();
    await recordCookedMeal(sql!, owner.userId, owner.householdId, "kycklinggryta", []);

    await withUserContext(sql!, owner.userId, (tx) => tx`
      delete from households where id = ${owner.householdId}
    `);

    const [count] = await admin!<{ n: string }[]>`
      select count(*)::text as n from cooked_meals where household_id = ${owner.householdId}
    `;
    expect(count!.n).toBe("0");
  });
});
