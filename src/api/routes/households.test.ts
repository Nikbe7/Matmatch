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

// GET/PUT /api/households, against the real local Supabase stack — real database,
// real auth, no mocks. Repository correctness (round trip, member ordering, RLS) is
// covered in src/db/households.test.ts; what these tests prove is the wiring: a real
// HTTP request reads/replaces the caller's own household, never anyone else's, and a
// household edit actually changes what GET /api/tonight is willing to serve.

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

function buildApp(engineData?: EngineData): Express {
  const data =
    engineData ??
    makeEngineData({
      ingredients: [makeIngredient("morot")],
      templates: [
        makeTemplate("morotsgryta", {
          ingredient_slots: [makeSlot({ role: "vegetable", ingredient_id: "morot", substitutable: false })],
        }),
      ],
    });
  return createApp({ sql: sql!, engineData: data, verifyToken: verifyToken! });
}

async function userWithHousehold(app: Express, body: object = noRestrictionsBody) {
  const user = await createTestUser();
  const created = await request(app).post("/api/households").set(authHeader(user.accessToken)).send(body);
  expect(created.status).toBe(201);
  return user;
}

describe.skipIf(!stackAvailable)("GET /api/households", () => {
  it("returns 401 without a token", async () => {
    const app = buildApp();

    const response = await request(app).get("/api/households");

    expect(response.status).toBe(401);
  });

  it("returns 404 with a machine-readable code when the user has no household", async () => {
    const app = buildApp();
    const user = await createTestUser();

    const response = await request(app).get("/api/households").set(authHeader(user.accessToken));

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("household_not_found");
  });

  it("returns the caller's household in the same shape POST returns on create", async () => {
    const app = buildApp();
    const user = await createTestUser();
    const created = await request(app)
      .post("/api/households")
      .set(authHeader(user.accessToken))
      .send(noRestrictionsBody);

    const response = await request(app).get("/api/households").set(authHeader(user.accessToken));

    expect(response.status).toBe(200);
    expect(response.body).toEqual(created.body);
  });

  it("never returns another user's household", async () => {
    const app = buildApp();
    await userWithHousehold(app);
    const other = await createTestUser();

    const response = await request(app).get("/api/households").set(authHeader(other.accessToken));

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("household_not_found");
  });
});

describe.skipIf(!stackAvailable)("PUT /api/households", () => {
  it("returns 401 without a token", async () => {
    const app = buildApp();

    const response = await request(app).put("/api/households").send(noRestrictionsBody);

    expect(response.status).toBe(401);
  });

  it("returns 404 and does not create a household when the user has none yet", async () => {
    const app = buildApp();
    const user = await createTestUser();

    const response = await request(app)
      .put("/api/households")
      .set(authHeader(user.accessToken))
      .send(noRestrictionsBody);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("household_not_found");

    const stillNone = await request(app).get("/api/households").set(authHeader(user.accessToken));
    expect(stillNone.status).toBe(404);
  });

  it("rejects an invalid allergy value with 400, the same code POST uses, and writes nothing", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await request(app)
      .put("/api/households")
      .set(authHeader(user.accessToken))
      .send({ members: [{ type: "adult", portion_factor: 1, allergies: ["not-a-real-allergy"], dietary_flags: [] }] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");

    const unchanged = await request(app).get("/api/households").set(authHeader(user.accessToken));
    expect(unchanged.body.household).toEqual(noRestrictionsBody);
  });

  it("replaces the profile: fetch, update, fetch again, see the change", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const updatedBody = makeHousehold({ members: [{ type: "adult", portion_factor: 1, name: "Kim" }] });
    const put = await request(app).put("/api/households").set(authHeader(user.accessToken)).send(updatedBody);
    expect(put.status).toBe(200);
    expect(put.body.household).toEqual(updatedBody);

    const after = await request(app).get("/api/households").set(authHeader(user.accessToken));
    expect(after.status).toBe(200);
    expect(after.body.household).toEqual(updatedBody);
    // Same household row throughout — a replace, not a delete-and-recreate.
    expect(after.body.id).toBe(put.body.id);
  });

  it("cannot be used to write another user's household", async () => {
    const app = buildApp();
    const owner = await userWithHousehold(app);
    const attacker = await createTestUser();

    const response = await request(app)
      .put("/api/households")
      .set(authHeader(attacker.accessToken))
      .send(makeHousehold({ members: [{ type: "adult", portion_factor: 1, allergies: ["peanuts"] }] }));

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("household_not_found");

    // The owner's household is untouched by the attacker's failed attempt.
    const ownerRead = await request(app).get("/api/households").set(authHeader(owner.accessToken));
    expect(ownerRead.body.household).toEqual(noRestrictionsBody);
  });

  describe("allergy set correctness — exhaustive, not sampled", () => {
    it("adding an allergy to an existing member is reflected exactly", async () => {
      const app = buildApp();
      const user = await userWithHousehold(app);

      const withAllergy = makeHousehold({ allergies: ["gluten"] });
      await request(app).put("/api/households").set(authHeader(user.accessToken)).send(withAllergy);

      const after = await request(app).get("/api/households").set(authHeader(user.accessToken));
      expect(after.body.household.members[0].allergies).toEqual(["gluten"]);
    });

    it("removing an allergy is reflected exactly", async () => {
      const app = buildApp();
      const user = await userWithHousehold(app, makeHousehold({ allergies: ["gluten"] }));

      await request(app)
        .put("/api/households")
        .set(authHeader(user.accessToken))
        .send(makeHousehold({ allergies: [] }));

      const after = await request(app).get("/api/households").set(authHeader(user.accessToken));
      expect(after.body.household.members[0].allergies).toEqual([]);
    });

    it("removing the member who carried the only instance of an allergy removes it from the household", async () => {
      const app = buildApp();
      const twoMembers = makeHousehold({
        members: [
          { type: "adult", portion_factor: 1, allergies: ["fish"] },
          { type: "adult", portion_factor: 1 },
        ],
      });
      const user = await userWithHousehold(app, twoMembers);

      const oneMemberLeft = makeHousehold({
        members: [{ type: "adult", portion_factor: 1 }],
      });
      await request(app).put("/api/households").set(authHeader(user.accessToken)).send(oneMemberLeft);

      const after = await request(app).get("/api/households").set(authHeader(user.accessToken));
      const allAllergies = after.body.household.members.flatMap((member: { allergies: string[] }) => member.allergies);
      expect(allAllergies).toEqual([]);
    });

    it("an update that omits an allergy on an existing member removes it — PUT is full replace, not patch", async () => {
      const app = buildApp();
      const user = await userWithHousehold(
        app,
        makeHousehold({ allergies: ["gluten"], dietary_flags: ["vegetarian"] }),
      );

      // Same member, same dietary_flags, allergies simply absent from this write.
      await request(app)
        .put("/api/households")
        .set(authHeader(user.accessToken))
        .send(makeHousehold({ dietary_flags: ["vegetarian"] }));

      const after = await request(app).get("/api/households").set(authHeader(user.accessToken));
      expect(after.body.household.members[0].allergies).toEqual([]);
      expect(after.body.household.members[0].dietary_flags).toEqual(["vegetarian"]);
    });
  });
});

describe.skipIf(!stackAvailable)("PUT /api/households — Tonight impact", () => {
  it("a dish carrying a newly-added allergen never comes back once the household is updated", async () => {
    const engineData = makeEngineData({
      ingredients: [makeIngredient("jordnotter"), makeIngredient("morot")],
      allergenMappings: [
        { ingredient_id: "jordnotter", allergens: ["peanuts"], verification_status: "verified" },
        { ingredient_id: "morot", allergens: [], verification_status: "verified" },
      ],
      templates: [
        makeTemplate("satay", {
          ingredient_slots: [makeSlot({ role: "protein", ingredient_id: "jordnotter", substitutable: false })],
        }),
      ],
    });
    const app = buildApp(engineData);
    const user = await userWithHousehold(app);

    const before = await request(app).get("/api/tonight").set(authHeader(user.accessToken));
    expect(before.status).toBe(200);
    expect(before.body.result?.template.id).toBe("satay");

    await request(app)
      .put("/api/households")
      .set(authHeader(user.accessToken))
      .send(makeHousehold({ allergies: ["peanuts"] }));

    // Checked twice: the peanut allergy leaves this household with zero safe
    // templates, so a stale cache or a re-derived-from-scratch bug would show up as
    // the dish reappearing on either call, not just the first.
    for (let i = 0; i < 2; i++) {
      const after = await request(app).get("/api/tonight").set(authHeader(user.accessToken));
      expect(after.status).toBe(200);
      expect(after.body.result).toBeNull();
      expect(after.body.reason).toBe("no_safe_templates");
    }
  });
});
