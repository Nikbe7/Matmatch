import { afterAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { createTokenVerifier } from "../auth/verifyToken.js";
import type { Sql } from "../db/client.js";
import { loadEngineData, type EngineData } from "../engine/data.js";
import {
  LOCAL_JWKS_URL,
  LOCAL_ISSUER,
  appClient,
  createTestUser,
  isLocalStackAvailable,
} from "../db/__fixtures__/localStack.js";
import { createApp } from "./app.js";

// Integration tests against the real local Supabase stack — unmocked DB, unmocked
// auth. These are the tests proving the wiring, not the logic underneath it: engine
// correctness lives in src/engine/*.test.ts, repository correctness in
// src/db/*.test.ts. Here what matters is that a real HTTP request reaches the right
// code with the right identity and the right RLS context.

const stackAvailable = await isLocalStackAvailable();

let sql: Sql | undefined;
let engineData: EngineData | undefined;
let app: Express | undefined;
let verifyToken: ReturnType<typeof createTokenVerifier> | undefined;

if (stackAvailable) {
  sql = appClient();
  engineData = await loadEngineData();
  verifyToken = createTokenVerifier({
    jwksUrl: LOCAL_JWKS_URL,
    issuer: LOCAL_ISSUER,
    audience: "authenticated",
  });
  app = createApp({ sql, engineData, verifyToken });
}

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

const noRestrictionsBody = {
  members: [{ type: "adult", portion_factor: 1 }],
  allergies: [],
  dietary_flags: [],
};

describe("GET /health", () => {
  it("responds 200 without a token, even without the stack up", async () => {
    // Deliberately built without sql/engineData/verifyToken — a health check must
    // not depend on any of them.
    const healthOnlyApp = createApp({
      sql: undefined as unknown as Sql,
      engineData: undefined as unknown as EngineData,
      verifyToken: (() => {
        throw new Error("must not be called");
      }) as never,
    });

    const response = await request(healthOnlyApp).get("/health");

    expect(response.status).toBe(200);
  });
});

describe.skipIf(!stackAvailable)("authentication", () => {
  it("rejects a request with no Authorization header", async () => {
    const response = await request(app!).get("/api/tonight");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("unauthorized");
  });

  it("rejects a malformed Authorization header", async () => {
    const response = await request(app!).get("/api/tonight").set("Authorization", "not-a-bearer-token");

    expect(response.status).toBe(401);
  });

  it("rejects a structurally invalid token", async () => {
    const response = await request(app!).get("/api/tonight").set(authHeader("not.a.jwt"));

    expect(response.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    // A token this file controls signing for, in case GoTrue never issues an
    // already-expired one — same shape as verifyToken.test.ts's controlled-key suite.
    const { SignJWT, generateKeyPair } = await import("jose");
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const expired = await new SignJWT({ sub: crypto.randomUUID() })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(privateKey);

    const response = await request(app!).get("/api/tonight").set(authHeader(expired));

    expect(response.status).toBe(401);
  });

  it("rejects POST /api/households the same way as GET /api/tonight", async () => {
    const response = await request(app!)
      .post("/api/households")
      .send(noRestrictionsBody);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("unauthorized");
  });

  it("never leaks a stack trace or driver detail in an error body", async () => {
    const response = await request(app!).get("/api/tonight");

    const text = JSON.stringify(response.body);
    expect(text).not.toMatch(/node_modules|\.ts:\d+|at\s+\w+\s+\(/);
  });
});

describe.skipIf(!stackAvailable)("POST /api/households", () => {
  it("creates the household and it is readable back through the repository", async () => {
    const user = await createTestUser();

    const response = await request(app!)
      .post("/api/households")
      .set(authHeader(user.accessToken))
      .send({
        members: [
          { type: "adult", portion_factor: 1 },
          { type: "child", portion_factor: 0.6 },
        ],
        allergies: ["gluten"],
        dietary_flags: ["vegetarian"],
      });

    expect(response.status).toBe(201);
    expect(response.body.household.allergies).toEqual(["gluten"]);
    expect(response.body.owner_user_id).toBe(user.userId);

    const { getHousehold } = await import("../db/households.js");
    const stored = await getHousehold(sql!, user.userId, response.body.id);
    expect(stored?.household).toEqual(response.body.household);
  });

  it("rejects an invalid allergy value with 400 and writes nothing", async () => {
    const user = await createTestUser();

    const response = await request(app!)
      .post("/api/households")
      .set(authHeader(user.accessToken))
      .send({
        members: [{ type: "adult", portion_factor: 1 }],
        allergies: ["sesame"],
        dietary_flags: [],
      });

    expect(response.status).toBe(400);

    const { getHouseholdForOwner } = await import("../db/households.js");
    expect(await getHouseholdForOwner(sql!, user.userId)).toBeUndefined();
  });

  it("rejects malformed JSON with 400, not 500", async () => {
    const user = await createTestUser();

    const response = await request(app!)
      .post("/api/households")
      .set(authHeader(user.accessToken))
      .set("Content-Type", "application/json")
      .send("{not valid json");

    expect(response.status).toBe(400);
  });

  it("returns 409 on a second household for the same user", async () => {
    const user = await createTestUser();

    const first = await request(app!)
      .post("/api/households")
      .set(authHeader(user.accessToken))
      .send(noRestrictionsBody);
    expect(first.status).toBe(201);

    const second = await request(app!)
      .post("/api/households")
      .set(authHeader(user.accessToken))
      .send(noRestrictionsBody);

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("household_already_exists");
  });
});

describe.skipIf(!stackAvailable)("GET /api/tonight", () => {
  it("returns 404 with a machine-readable code when the user has no household", async () => {
    const user = await createTestUser();

    const response = await request(app!).get("/api/tonight").set(authHeader(user.accessToken));

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("household_not_found");
  });

  it("returns a picked template for a household with no restrictions", async () => {
    const user = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(user.accessToken)).send(noRestrictionsBody);

    const response = await request(app!).get("/api/tonight").set(authHeader(user.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.result).not.toBeNull();
    expect(response.body.result.template).toBeDefined();
    expect(typeof response.body.result.score).toBe("number");
    expect(Array.isArray(response.body.result.substitutions)).toBe(true);

    // Every slot must carry a real, catalog-resolved Swedish name (#64) — never an
    // empty string standing in for a lookup miss.
    const { ingredients, template } = response.body.result;
    expect(Array.isArray(ingredients)).toBe(true);
    expect(ingredients).toHaveLength(template.ingredient_slots.length);
    for (const ingredient of ingredients) {
      expect(typeof ingredient.name).toBe("string");
      expect(ingredient.name.length).toBeGreaterThan(0);
    }
  });

  it("sums portion_factor across all members, including a child at 0.5, into `portions`", async () => {
    const user = await createTestUser();
    await request(app!)
      .post("/api/households")
      .set(authHeader(user.accessToken))
      .send({
        members: [
          { type: "adult", portion_factor: 1 },
          { type: "adult", portion_factor: 1 },
          { type: "child", portion_factor: 0.5 },
        ],
        allergies: [],
        dietary_flags: [],
      });

    const response = await request(app!).get("/api/tonight").set(authHeader(user.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.portions).toBe(2.5);
  });

  it("returns a null result with a reason for a household with no safe templates", async () => {
    // Even the worst real profile (all 8 allergies + vegan) still leaves 14 of 170
    // templates (verified while writing this test) — the catalog cannot currently
    // produce a genuinely empty candidate set, which is a good property of the data,
    // not a gap in this test. So the empty branch is exercised through a real HTTP
    // request against a real, minimal EngineData (zero templates) rather than a
    // fabricated response: selectCandidateTemplates necessarily returns [] for it,
    // and everything from there down — pickTonight, the route, the JSON body — is
    // the genuine code path.
    const emptyEngineData: EngineData = {
      ingredientsById: new Map(),
      allergenMappingByIngredientId: new Map(),
      templates: [],
      substitutionGroupsById: new Map(),
      substitutionGroupsByMemberIngredientId: new Map(),
    };
    const emptyApp = createApp({ sql: sql!, engineData: emptyEngineData, verifyToken: verifyToken! });

    const user = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(user.accessToken)).send(noRestrictionsBody);

    const response = await request(emptyApp).get("/api/tonight").set(authHeader(user.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.result).toBeNull();
    expect(response.body.reason).toBe("no_safe_templates");
  });

  it("never returns another user's household data", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();

    await request(app!)
      .post("/api/households")
      .set(authHeader(bob.accessToken))
      .send({
        members: [{ type: "adult", portion_factor: 1 }],
        allergies: [],
        dietary_flags: ["vegan"],
      });

    // Alice has no household of her own — if the route's RLS context were not wired
    // through (e.g. it queried without the per-request user set), this request could
    // return Bob's vegan household instead of Alice's true "no household" state.
    const response = await request(app!).get("/api/tonight").set(authHeader(alice.accessToken));

    expect(response.status).toBe(404);
  });

  it("moves the pick toward budget templates as cost weight rises", async () => {
    const user = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(user.accessToken)).send(noRestrictionsBody);

    const cheap = await request(app!)
      .get("/api/tonight")
      .query({ cost: "10", time: "0" })
      .set(authHeader(user.accessToken));

    expect(cheap.status).toBe(200);
    expect(cheap.body.result.template.cost_tier).toBe("budget");
  });

  it("moves the pick toward fast templates as time weight rises", async () => {
    const user = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(user.accessToken)).send(noRestrictionsBody);

    const fast = await request(app!)
      .get("/api/tonight")
      .query({ cost: "0", time: "10" })
      .set(authHeader(user.accessToken));

    expect(fast.status).toBe(200);
    expect(fast.body.result.template.prep_time_band).toBe("<20min");
  });

  it("defaults to {cost: 0, time: 0} when no weights are supplied", async () => {
    const user = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(user.accessToken)).send(noRestrictionsBody);

    const withoutParams = await request(app!).get("/api/tonight").set(authHeader(user.accessToken));
    const withExplicitDefaults = await request(app!)
      .get("/api/tonight")
      .query({ cost: "0", time: "0" })
      .set(authHeader(user.accessToken));

    expect(withoutParams.body.result.template.id).toBe(withExplicitDefaults.body.result.template.id);
  });

  it.each([
    ["cost", "not-a-number"],
    ["time", "-1"],
    ["cost", "Infinity"],
    ["time", "NaN"],
  ])("rejects an invalid %s weight (%s) with 400", async (param, value) => {
    const user = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(user.accessToken)).send(noRestrictionsBody);

    const response = await request(app!)
      .get("/api/tonight")
      .query({ [param]: value })
      .set(authHeader(user.accessToken));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_weights");
  });

  it("excludes the given template ids from the result", async () => {
    const user = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(user.accessToken)).send(noRestrictionsBody);

    const first = await request(app!).get("/api/tonight").set(authHeader(user.accessToken));
    const excludedId = first.body.result.template.id as string;

    const second = await request(app!)
      .get("/api/tonight")
      .query({ exclude: excludedId })
      .set(authHeader(user.accessToken));

    expect(second.status).toBe(200);
    expect(second.body.result.template.id).not.toBe(excludedId);
  });

  it("lets `previous` influence which dish comes back", async () => {
    const user = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(user.accessToken)).send(noRestrictionsBody);

    const first = await request(app!).get("/api/tonight").set(authHeader(user.accessToken));
    const previousId = first.body.result.template.id as string;

    const withoutPrevious = await request(app!).get("/api/tonight").set(authHeader(user.accessToken));
    const withPrevious = await request(app!)
      .get("/api/tonight")
      .query({ previous: previousId })
      .set(authHeader(user.accessToken));

    expect(withPrevious.status).toBe(200);
    // Same top-of-list result without `previous`, but `previous` alone (no
    // exclusion) is enough to steer the pick toward a different protein_group.
    expect(withoutPrevious.body.result.template.id).toBe(previousId);
    expect(withPrevious.body.result.template.id).not.toBe(previousId);
  });

  it.each([
    ["exclude", "invalid_exclude"],
    ["previous", "invalid_previous"],
  ])("rejects a repeated `%s` parameter with 400", async (param, code) => {
    const user = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(user.accessToken)).send(noRestrictionsBody);

    // Express parses a repeated query parameter as an array — a client bug, and
    // one that would otherwise silently show a dish the household already rejected.
    const response = await request(app!)
      .get(`/api/tonight?${param}=one&${param}=two`)
      .set(authHeader(user.accessToken));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(code);
  });

  it("accepts an empty `exclude` and an empty `previous` as no selection state at all", async () => {
    const user = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(user.accessToken)).send(noRestrictionsBody);

    const plain = await request(app!).get("/api/tonight").set(authHeader(user.accessToken));
    const empty = await request(app!)
      .get("/api/tonight")
      .query({ exclude: "", previous: "" })
      .set(authHeader(user.accessToken));

    expect(empty.status).toBe(200);
    expect(empty.body.result.template.id).toBe(plain.body.result.template.id);
  });

  it("does not error when the exclude list is over 30 ids, and ignores unknown ids", async () => {
    const user = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(user.accessToken)).send(noRestrictionsBody);

    const manyUnknownIds = Array.from({ length: 40 }, (_, i) => `not-a-real-template-${i}`).join(",");

    const response = await request(app!)
      .get("/api/tonight")
      .query({ exclude: manyUnknownIds })
      .set(authHeader(user.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.result).not.toBeNull();
  });

  it("returns `no_more_suggestions` (not `no_safe_templates`) once every safe template is excluded", async () => {
    // A minimal, real EngineData (two dinner templates, no restrictions needed to
    // pass) so "exclude everything" stays well under the 30-id cap and this test
    // doesn't depend on the size of the real catalog — same rationale as the
    // no_safe_templates test above using a fabricated EngineData rather than trying
    // to hit a genuinely empty state through real data.
    const { makeEngineData, makeIngredient, makeTemplate } = await import(
      "../engine/__fixtures__/engineData.js"
    );
    const twoTemplateEngineData: EngineData = makeEngineData({
      ingredients: [makeIngredient("morot")],
      templates: [
        makeTemplate("morotssoppa", {
          ingredient_slots: [{ role: "vegetable", ingredient_id: "morot", substitutable: false }],
        }),
        makeTemplate("morotsgryta", {
          ingredient_slots: [{ role: "vegetable", ingredient_id: "morot", substitutable: false }],
        }),
      ],
    });
    const twoTemplateApp = createApp({ sql: sql!, engineData: twoTemplateEngineData, verifyToken: verifyToken! });

    const user = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(user.accessToken)).send(noRestrictionsBody);

    const response = await request(twoTemplateApp)
      .get("/api/tonight")
      .query({ exclude: "morotssoppa,morotsgryta" })
      .set(authHeader(user.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.result).toBeNull();
    expect(response.body.reason).toBe("no_more_suggestions");
  });
});
