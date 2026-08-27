import type { Express } from "express";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createTokenVerifier } from "../../auth/verifyToken.js";
import type { Sql } from "../../db/client.js";
import {
  LOCAL_ISSUER,
  LOCAL_JWKS_URL,
  appClient,
  createTestUser,
  isLocalStackAvailable,
} from "../../db/__fixtures__/localStack.js";
import { makeEngineData, makeIngredient, makeSlot, makeTemplate } from "../../engine/__fixtures__/engineData.js";
import { makeHousehold } from "../../engine/__fixtures__/household.js";
import type { EngineData } from "../../engine/data.js";
import { createApp } from "../app.js";

// GET /api/ingredients/alternatives (#124), against the real local Supabase stack —
// real database, real auth, no mocks. Deterministic classification (which candidate
// is cheaper/similar, which candidates a role admits) is covered exhaustively in
// src/engine/candidates.test.ts and src/api/ingredientAlternatives.test.ts; what this
// file proves is the wiring: request validation, the household on the row is the one
// that gates the response, and the route never widens what the engine already
// decided.

const stackAvailable = await isLocalStackAvailable();

let sql: Sql | undefined;
let verifyToken: ReturnType<typeof createTokenVerifier> | undefined;

if (stackAvailable) {
  sql = appClient();
  verifyToken = createTokenVerifier({
    jwksUrl: LOCAL_JWKS_URL,
    issuer: LOCAL_ISSUER,
    audience: "authenticated",
  });
}

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function buildApp(engineData: EngineData): Express {
  return createApp({ sql: sql!, engineData, verifyToken: verifyToken! });
}

async function userWithHousehold(app: Express, household: object = makeHousehold()) {
  const user = await createTestUser();
  const created = await request(app).post("/api/households").set(authHeader(user.accessToken)).send(household);
  expect(created.status).toBe(201);
  return user;
}

const templateId = "gryta";

function buildFixture(): EngineData {
  return makeEngineData({
    ingredients: [
      makeIngredient("gul-lok", { default_cost_tier: "budget" }),
      makeIngredient("rodlok", { default_cost_tier: "budget" }),
      makeIngredient("schalottenlok", { default_cost_tier: "mid" }),
      makeIngredient("kyckling", { category: "protein", default_cost_tier: "mid" }),
      makeIngredient("tofu", { category: "protein", default_cost_tier: "budget" }),
    ],
    substitutionGroups: [
      {
        id: "lok",
        name: "Lök",
        role: "aromatic" as const,
        member_ingredient_ids: ["gul-lok", "rodlok", "schalottenlok"],
      },
    ],
    templates: [
      makeTemplate(templateId, {
        ingredient_slots: [
          makeSlot({ role: "aromatic", ingredient_id: "gul-lok", substitutable: true }),
          makeSlot({ role: "protein", ingredient_id: "kyckling", substitutable: false }),
        ],
      }),
    ],
  });
}

function alternatives(app: Express, token: string, query: Record<string, string>) {
  return request(app).get("/api/ingredients/alternatives").query(query).set(authHeader(token));
}

describe.skipIf(!stackAvailable)("GET /api/ingredients/alternatives", () => {
  it("returns 401 without a token", async () => {
    const response = await request(buildApp(buildFixture())).get("/api/ingredients/alternatives");
    expect(response.status).toBe(401);
  });

  it("returns 404 for an unknown template id", async () => {
    const app = buildApp(buildFixture());
    const user = await userWithHousehold(app);

    const response = await alternatives(app, user.accessToken, {
      template: "not-a-real-template",
      slot: "0",
      ingredient: "gul-lok",
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("template_not_found");
  });

  it("returns 400 for a slot index outside the template", async () => {
    const app = buildApp(buildFixture());
    const user = await userWithHousehold(app);

    const response = await alternatives(app, user.accessToken, {
      template: templateId,
      slot: "9",
      ingredient: "gul-lok",
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_slot");
  });

  it("returns 400 for an ingredient id outside the catalog", async () => {
    const app = buildApp(buildFixture());
    const user = await userWithHousehold(app);

    const response = await alternatives(app, user.accessToken, {
      template: templateId,
      slot: "0",
      ingredient: "not-a-real-ingredient",
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_ingredient");
  });

  it("returns 404 when the user has no household", async () => {
    const app = buildApp(buildFixture());
    const user = await createTestUser();

    const response = await alternatives(app, user.accessToken, {
      template: templateId,
      slot: "0",
      ingredient: "gul-lok",
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("household_not_found");
  });

  it("answers substitutable: false and nothing else for a non-substitutable slot", async () => {
    const app = buildApp(buildFixture());
    const user = await userWithHousehold(app);

    const response = await alternatives(app, user.accessToken, {
      template: templateId,
      slot: "1",
      ingredient: "kyckling",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ substitutable: false });
  });

  it("classifies the curated alternatives by cost tier and returns the wider search pool", async () => {
    const app = buildApp(buildFixture());
    const user = await userWithHousehold(app);

    const response = await alternatives(app, user.accessToken, {
      template: templateId,
      slot: "0",
      ingredient: "gul-lok",
    });

    expect(response.status).toBe(200);
    expect(response.body.substitutable).toBe(true);
    // gul-lok and rodlok are both budget — same tier, so "similar", not "cheaper".
    expect(response.body.similar.map((a: { ingredientId: string }) => a.ingredientId)).toEqual(["rodlok"]);
    expect(response.body.cheaper).toBeUndefined();
    expect(
      response.body.searchPool.map((a: { ingredientId: string }) => a.ingredientId).sort(),
    ).toEqual(["rodlok", "schalottenlok"]);
  });

  it("scales the returned quantity to the household's portions, identically across every alternative", async () => {
    const app = buildApp(buildFixture());
    const user = await userWithHousehold(
      app,
      makeHousehold({ members: [{}, { type: "adult", portion_factor: 1 }] }),
    );

    const response = await alternatives(app, user.accessToken, {
      template: templateId,
      slot: "0",
      ingredient: "gul-lok",
    });

    expect(response.status).toBe(200);
    const quantities = [...response.body.similar, ...response.body.searchPool].map(
      (a: { quantity: unknown }) => a.quantity,
    );
    expect(quantities.length).toBeGreaterThan(0);
    for (const quantity of quantities) {
      expect(quantity).toEqual(quantities[0]);
    }
  });
});
