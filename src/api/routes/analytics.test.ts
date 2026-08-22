import type { Express } from "express";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createTokenVerifier } from "../../auth/verifyToken.js";
import type { Sql } from "../../db/client.js";
import {
  LOCAL_ISSUER,
  LOCAL_JWKS_URL,
  appClient,
  bypassClient,
  createTestUser,
  isLocalStackAvailable,
} from "../../db/__fixtures__/localStack.js";
import { makeEngineData } from "../../engine/__fixtures__/engineData.js";
import type { EngineData } from "../../engine/data.js";
import { createApp } from "../app.js";
import { makeHousehold } from "../../engine/__fixtures__/household.js";

// POST /api/analytics/events (issue #91), against the real local Supabase stack —
// real database, real auth, no mocks. RLS and storage shape are covered in
// src/db/analyticsEvents.test.ts; what these tests prove is the HTTP contract: auth,
// the closed event vocabulary, and that a batch either stores completely or not at
// all.

const stackAvailable = await isLocalStackAvailable();

let sql: Sql | undefined;
let admin: Sql | undefined;
let verifyToken: ReturnType<typeof createTokenVerifier> | undefined;

if (stackAvailable) {
  sql = appClient();
  admin = bypassClient();
  verifyToken = createTokenVerifier({
    jwksUrl: LOCAL_JWKS_URL,
    issuer: LOCAL_ISSUER,
    audience: "authenticated",
  });
}

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await admin?.end({ timeout: 5 });
});

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

const noRestrictionsBody = makeHousehold();

function buildApp(): Express {
  const engineData: EngineData = makeEngineData({});
  return createApp({ sql: sql!, engineData, verifyToken: verifyToken! });
}

async function userWithHousehold(app: Express) {
  const user = await createTestUser();
  const created = await request(app)
    .post("/api/households")
    .set(authHeader(user.accessToken))
    .send(noRestrictionsBody);
  expect(created.status).toBe(201);
  return user;
}

const validClientTimestamp = "2026-08-05T18:00:00.000Z";

const validMealChosenEvent = {
  event: { name: "meal_chosen", templateId: "kycklinggryta", rerollDepth: 0 },
  clientTimestamp: validClientTimestamp,
};

async function countEvents(householdOwnerId: string): Promise<number> {
  const [row] = await admin!<{ n: string }[]>`
    select count(*)::text as n
    from analytics_events e
    join households h on h.id = e.household_id
    where h.owner_user_id = ${householdOwnerId}
  `;
  return Number(row!.n);
}

describe.skipIf(!stackAvailable)("POST /api/analytics/events", () => {
  it("returns 401 without a token", async () => {
    const app = buildApp();

    const response = await request(app)
      .post("/api/analytics/events")
      .send({ events: [validMealChosenEvent] });

    expect(response.status).toBe(401);
  });

  it("returns 404 with a machine-readable code when the user has no household", async () => {
    const app = buildApp();
    const user = await createTestUser();

    const response = await request(app)
      .post("/api/analytics/events")
      .set(authHeader(user.accessToken))
      .send({ events: [validMealChosenEvent] });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("household_not_found");
  });

  it("returns 400 for an empty events array", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await request(app)
      .post("/api/analytics/events")
      .set(authHeader(user.accessToken))
      .send({ events: [] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
  });

  it("returns 400 and stores nothing for an unknown event name, even alongside a valid event", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await request(app)
      .post("/api/analytics/events")
      .set(authHeader(user.accessToken))
      .send({
        events: [
          validMealChosenEvent,
          { event: { name: "typoed_event", rerollDepth: 0 }, clientTimestamp: validClientTimestamp },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
    expect(await countEvents(user.userId)).toBe(0);
  });

  it("returns 400 for an event payload with an extra field beyond the fixed shape", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await request(app)
      .post("/api/analytics/events")
      .set(authHeader(user.accessToken))
      .send({
        events: [
          {
            event: {
              name: "meal_chosen",
              templateId: "kycklinggryta",
              rerollDepth: 0,
              freeText: "not part of the contract",
            },
            clientTimestamp: validClientTimestamp,
          },
        ],
      });

    expect(response.status).toBe(400);
    expect(await countEvents(user.userId)).toBe(0);
  });

  it("stores a batch of valid events under the caller's own household and answers 204", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await request(app)
      .post("/api/analytics/events")
      .set(authHeader(user.accessToken))
      .send({
        events: [
          validMealChosenEvent,
          {
            event: {
              name: "refinement_chip_tap",
              chip: "cheaper",
              weights: { price: 1, time: 0, variation: 0, simplicity: 0 },
              level: 1,
              rerollDepth: 0,
            },
            clientTimestamp: validClientTimestamp,
          },
          {
            event: { name: "refinement_session_abandoned", rerollDepth: 3 },
            clientTimestamp: validClientTimestamp,
          },
          {
            event: { name: "meal_choice_history_failed", templateId: "kycklinggryta" },
            clientTimestamp: validClientTimestamp,
          },
        ],
      });

    expect(response.status).toBe(204);
    expect(await countEvents(user.userId)).toBe(4);
  });

  // The full chip vocabulary web/src/refinement.ts's ChipId union can actually
  // produce — kept in sync by hand with that file, the same mirroring discipline
  // the module comment above describes for the rest of this file. This is the
  // regression test for #197: three of these eight ids (try_new, simpler, pantry)
  // were missing from ChipIdSchema, so any batch containing one of them — including
  // the meal_chosen event riding alongside it — was rejected whole and silently
  // dropped by the client.
  const allChipIds = [
    "cheaper",
    "faster",
    "try_new",
    "simpler",
    "other_cuisine",
    "something_else",
    "reset",
    "pantry",
  ] as const;

  it.each(allChipIds)(
    "accepts a refinement_chip_tap for chip id %s, alongside a meal_chosen event",
    async (chip) => {
      const app = buildApp();
      const user = await userWithHousehold(app);

      const response = await request(app)
        .post("/api/analytics/events")
        .set(authHeader(user.accessToken))
        .send({
          events: [
            validMealChosenEvent,
            {
              event: {
                name: "refinement_chip_tap",
                chip,
                weights: { price: 35, time: 0, variation: 0, simplicity: 0 },
                rerollDepth: 1,
              },
              clientTimestamp: validClientTimestamp,
            },
          ],
        });

      expect(response.status).toBe(204);
      expect(await countEvents(user.userId)).toBe(2);
    },
  );

  it("accepts an app_error_shown event — the whole event type #197 also found missing", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await request(app)
      .post("/api/analytics/events")
      .set(authHeader(user.accessToken))
      .send({
        events: [
          {
            event: { name: "app_error_shown", context: "tonight_no_result", code: "no_match" },
            clientTimestamp: validClientTimestamp,
          },
        ],
      });

    expect(response.status).toBe(204);
    expect(await countEvents(user.userId)).toBe(1);
  });

  it("stores events under the caller's own household only", async () => {
    const app = buildApp();
    const alice = await userWithHousehold(app);
    const bob = await userWithHousehold(app);

    await request(app)
      .post("/api/analytics/events")
      .set(authHeader(alice.accessToken))
      .send({ events: [validMealChosenEvent] });

    expect(await countEvents(bob.userId)).toBe(0);
    expect(await countEvents(alice.userId)).toBe(1);
  });
});
