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
import { makeEngineData, makeIngredient, makeSlot, makeTemplate } from "../../engine/__fixtures__/engineData.js";
import type { EngineData } from "../../engine/data.js";
import { createApp } from "../app.js";
import { makeHousehold } from "../../engine/__fixtures__/household.js";

// POST /api/cooked and its effect on GET /api/tonight (issue #88), against the real
// local Supabase stack — real database, real auth, no mocks. Repository behaviour
// (idempotency constraint, RLS) is covered in src/db/cookedMeals.test.ts and ranking
// behaviour in src/engine/ranking.test.ts; what these tests prove is the wiring: a real
// HTTP request records history under the caller's own household, and the *next* Tonight
// request actually ranks differently because of it.

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

/**
 * Two interchangeable dinner templates, distinguished only by id, plus a substitutable
 * slot so the substitution path is reachable. Two is the minimum that can show
 * repeat-avoidance: cook the one Tonight offers, and the other must come back next.
 */
function buildApp(): { app: Express; first: string; second: string } {
  const first = "a-kycklinggryta";
  const second = "b-fisksoppa";
  const slots = [
    makeSlot({ role: "protein", ingredient_id: "kyckling", substitutable: true }),
    makeSlot({ role: "vegetable", ingredient_id: "morot", substitutable: false }),
  ];

  const engineData: EngineData = makeEngineData({
    ingredients: [makeIngredient("kyckling"), makeIngredient("tofu"), makeIngredient("morot")],
    templates: [
      makeTemplate(first, { ingredient_slots: slots }),
      makeTemplate(second, { ingredient_slots: slots }),
    ],
  });

  return {
    app: createApp({ sql: sql!, engineData, verifyToken: verifyToken! }),
    first,
    second,
  };
}

/** A signed-up user who already has a household, ready to cook. */
async function userWithHousehold(app: Express) {
  const user = await createTestUser();
  const created = await request(app)
    .post("/api/households")
    .set(authHeader(user.accessToken))
    .send(noRestrictionsBody);
  expect(created.status).toBe(201);
  return user;
}

describe.skipIf(!stackAvailable)("POST /api/cooked", () => {
  it("returns 401 without a token", async () => {
    const { app, first } = buildApp();

    const response = await request(app).post("/api/cooked").send({ templateId: first });

    expect(response.status).toBe(401);
  });

  it("returns 404 with a machine-readable code when the user has no household", async () => {
    const { app, first } = buildApp();
    const user = await createTestUser();

    const response = await request(app)
      .post("/api/cooked")
      .set(authHeader(user.accessToken))
      .send({ templateId: first });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("household_not_found");
  });

  it("returns 404 for an unknown template id", async () => {
    const { app } = buildApp();
    const user = await userWithHousehold(app);

    const response = await request(app)
      .post("/api/cooked")
      .set(authHeader(user.accessToken))
      .send({ templateId: "not-a-real-template" });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("template_not_found");
  });

  it("returns 400 for a substitution slot_index the template does not have", async () => {
    const { app, first } = buildApp();
    const user = await userWithHousehold(app);

    const response = await request(app)
      .post("/api/cooked")
      .set(authHeader(user.accessToken))
      .send({ templateId: first, substitutions: [{ slot_index: 9, substitute_ingredient_id: "tofu" }] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_substitution");
  });

  it("returns 400 for a request with no template id", async () => {
    const { app } = buildApp();
    const user = await userWithHousehold(app);

    const response = await request(app)
      .post("/api/cooked")
      .set(authHeader(user.accessToken))
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
  });

  it("records the meal and answers 200 with the stored timestamp", async () => {
    const { app, first } = buildApp();
    const user = await userWithHousehold(app);

    const response = await request(app)
      .post("/api/cooked")
      .set(authHeader(user.accessToken))
      .send({ templateId: first, substitutions: [{ slot_index: 0, substitute_ingredient_id: "tofu" }] });

    expect(response.status).toBe(200);
    expect(response.body.cooked.templateId).toBe(first);
    expect(Number.isNaN(Date.parse(response.body.cooked.cookedAt))).toBe(false);
  });

  it("is idempotent for a double tap: 200 twice, one row, same timestamp", async () => {
    const { app, first } = buildApp();
    const user = await userWithHousehold(app);

    const one = await request(app).post("/api/cooked").set(authHeader(user.accessToken)).send({ templateId: first });
    const two = await request(app).post("/api/cooked").set(authHeader(user.accessToken)).send({ templateId: first });

    // Not a 409: the household did nothing wrong and the end state is what they asked for.
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(two.body.cooked.cookedAt).toBe(one.body.cooked.cookedAt);

    const [count] = await admin!<{ n: string }[]>`
      select count(*)::text as n
      from cooked_meals c
      join households h on h.id = c.household_id
      where h.owner_user_id = ${user.userId}
    `;
    expect(count!.n).toBe("1");
  });

  it("records history against the caller's own household only", async () => {
    const { app, first } = buildApp();
    const alice = await userWithHousehold(app);
    const bob = await userWithHousehold(app);

    await request(app).post("/api/cooked").set(authHeader(alice.accessToken)).send({ templateId: first });

    const [count] = await admin!<{ n: string }[]>`
      select count(*)::text as n
      from cooked_meals c
      join households h on h.id = c.household_id
      where h.owner_user_id = ${bob.userId}
    `;
    expect(count!.n).toBe("0");
  });
});

describe.skipIf(!stackAvailable)("GET /api/tonight — cooked history", () => {
  it("suggests a different dish the next time, once the first was marked cooked", async () => {
    const { app, first, second } = buildApp();
    const user = await userWithHousehold(app);

    const before = await request(app).get("/api/tonight").set(authHeader(user.accessToken));
    expect(before.status).toBe(200);
    expect(before.body.result.template.id).toBe(first);
    expect(before.body.result.cookedToday).toBe(false);

    await request(app).post("/api/cooked").set(authHeader(user.accessToken)).send({ templateId: first });

    // The whole point of #88: same household, same weights, same session — a different
    // dish, because the recency penalty now outweighs everything else at default weights.
    const after = await request(app).get("/api/tonight").set(authHeader(user.accessToken));
    expect(after.status).toBe(200);
    expect(after.body.result.template.id).toBe(second);
    expect(after.body.result.cookedToday).toBe(false);
  });

  it("reports cookedToday for the dish on the card once it has been marked", async () => {
    const { app, first, second } = buildApp();
    const user = await userWithHousehold(app);

    // Mark both, so whichever one ranking offers is one the household cooked today —
    // this is also the "cooked everything" case that must not empty the card.
    await request(app).post("/api/cooked").set(authHeader(user.accessToken)).send({ templateId: first });
    await request(app).post("/api/cooked").set(authHeader(user.accessToken)).send({ templateId: second });

    const response = await request(app).get("/api/tonight").set(authHeader(user.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.result).not.toBeNull();
    expect(response.body.result.cookedToday).toBe(true);
  });

  it("never empties the card for a household that cooked its only candidate today", async () => {
    const single = "enda-ratten";
    const engineData: EngineData = makeEngineData({
      ingredients: [makeIngredient("morot")],
      templates: [
        makeTemplate(single, {
          ingredient_slots: [makeSlot({ role: "vegetable", ingredient_id: "morot", substitutable: false })],
        }),
      ],
    });
    const app = createApp({ sql: sql!, engineData, verifyToken: verifyToken! });
    const user = await userWithHousehold(app);

    await request(app).post("/api/cooked").set(authHeader(user.accessToken)).send({ templateId: single });

    const response = await request(app).get("/api/tonight").set(authHeader(user.accessToken));

    // Penalised, not filtered (UX_FLOW §9 — never dead-end the user).
    expect(response.status).toBe(200);
    expect(response.body.result.template.id).toBe(single);
    expect(response.body.result.cookedToday).toBe(true);
  });

  it("does not let one household's history affect another's suggestion", async () => {
    const { app, first } = buildApp();
    const alice = await userWithHousehold(app);
    const bob = await userWithHousehold(app);

    await request(app).post("/api/cooked").set(authHeader(alice.accessToken)).send({ templateId: first });

    const bobsTonight = await request(app).get("/api/tonight").set(authHeader(bob.accessToken));

    expect(bobsTonight.body.result.template.id).toBe(first);
    expect(bobsTonight.body.result.cookedToday).toBe(false);
  });
});
