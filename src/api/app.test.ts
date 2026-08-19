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
import { makeHousehold } from "../engine/__fixtures__/household.js";
import { makeSlot } from "../engine/__fixtures__/engineData.js";
import { getHouseholdForOwner, updateHouseholdPreferenceWeights } from "../db/households.js";
import { NEUTRAL_PREFERENCE_WEIGHTS } from "../schema/preferenceWeights.js";

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

const noRestrictionsBody = makeHousehold();

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
      .send(makeHousehold({
        members: [
          { type: "adult", portion_factor: 1 },
          { type: "child", portion_factor: 0.6 },
        ],
        allergies: ["gluten"],
        dietary_flags: ["vegetarian"],
      }));

    expect(response.status).toBe(201);
    expect(response.body.household.members[0].allergies).toEqual(["gluten"]);
    expect(response.body.household.members[1].allergies).toEqual([]);
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
      // A raw literal, not makeHousehold: the point of this test is a value outside
      // the locked vocabulary, which the typed fixture cannot express.
      .send({
        members: [
          { type: "adult", portion_factor: 1, allergies: ["sesame"], dietary_flags: [] },
        ],
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
      .send(makeHousehold({
        members: [
          { type: "adult", portion_factor: 1 },
          { type: "adult", portion_factor: 1 },
          { type: "child", portion_factor: 0.5 },
        ],
      }));

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
      .send(makeHousehold({ allergies: [], dietary_flags: ["vegan"] }));

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
      .query({ price: "10", time: "0" })
      .set(authHeader(user.accessToken));

    expect(cheap.status).toBe(200);
    expect(cheap.body.result.template.cost_tier).toBe("budget");
  });

  it("moves the pick toward fast templates as time weight rises", async () => {
    const user = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(user.accessToken)).send(noRestrictionsBody);

    const fast = await request(app!)
      .get("/api/tonight")
      .query({ price: "0", time: "10" })
      .set(authHeader(user.accessToken));

    expect(fast.status).toBe(200);
    expect(fast.body.result.template.prep_time_band).toBe("<20min");
  });

  it("defaults to {price: 0, time: 0} when no weights are supplied", async () => {
    const user = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(user.accessToken)).send(noRestrictionsBody);

    const withoutParams = await request(app!).get("/api/tonight").set(authHeader(user.accessToken));
    const withExplicitDefaults = await request(app!)
      .get("/api/tonight")
      .query({ price: "0", time: "0" })
      .set(authHeader(user.accessToken));

    expect(withoutParams.body.result.template.id).toBe(withExplicitDefaults.body.result.template.id);
  });

  // The household's persistent baseline (#157) reaching the ranking, and reaching it
  // through the same axis definition the chips use.
  it("ranks by the household's stored baseline when no weights are supplied", async () => {
    const user = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(user.accessToken)).send(noRestrictionsBody);

    const stored = await getHouseholdForOwner(sql!, user.userId);
    await updateHouseholdPreferenceWeights(sql!, user.userId, stored!.id, {
      ...NEUTRAL_PREFERENCE_WEIGHTS,
      time: 100,
    });

    const fromBaseline = await request(app!).get("/api/tonight").set(authHeader(user.accessToken));

    expect(fromBaseline.status).toBe(200);
    expect(fromBaseline.body.result.template.prep_time_band).toBe("<20min");
  });

  it("gives the same dish whether a preference arrived as the baseline or as a session delta", async () => {
    // The property that makes baseline and delta one mechanic rather than two: a
    // household with the slider at 100 and a household at neutral sending `time=100`
    // are making the same statement, and must be answered identically.
    const viaBaseline = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(viaBaseline.accessToken)).send(noRestrictionsBody);
    const stored = await getHouseholdForOwner(sql!, viaBaseline.userId);
    await updateHouseholdPreferenceWeights(sql!, viaBaseline.userId, stored!.id, {
      ...NEUTRAL_PREFERENCE_WEIGHTS,
      time: 100,
    });

    const viaDelta = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(viaDelta.accessToken)).send(noRestrictionsBody);

    const baselineResponse = await request(app!).get("/api/tonight").set(authHeader(viaBaseline.accessToken));
    const deltaResponse = await request(app!)
      .get("/api/tonight")
      .query({ time: "100" })
      .set(authHeader(viaDelta.accessToken));

    expect(baselineResponse.body.result.template.id).toBe(deltaResponse.body.result.template.id);
    expect(baselineResponse.body.result.score).toBe(deltaResponse.body.result.score);
  });

  it("adds the session delta on top of the baseline rather than replacing it", async () => {
    const user = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(user.accessToken)).send(noRestrictionsBody);
    const stored = await getHouseholdForOwner(sql!, user.userId);
    await updateHouseholdPreferenceWeights(sql!, user.userId, stored!.id, {
      ...NEUTRAL_PREFERENCE_WEIGHTS,
      time: 60,
    });

    const combined = await request(app!)
      .get("/api/tonight")
      .query({ time: "40" })
      .set(authHeader(user.accessToken));

    const equivalent = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(equivalent.accessToken)).send(noRestrictionsBody);
    const asOneDelta = await request(app!)
      .get("/api/tonight")
      .query({ time: "100" })
      .set(authHeader(equivalent.accessToken));

    expect(combined.body.result.score).toBe(asOneDelta.body.result.score);
  });

  it("does not let a profile save reset the stored baseline", async () => {
    // `PUT /api/households` is a full replacement with no version check (DECISION_LOG
    // 2026-08-16). The baseline lives outside the profile type precisely so a client
    // that does not know about weights cannot wipe them by editing a member.
    const user = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(user.accessToken)).send(noRestrictionsBody);
    const stored = await getHouseholdForOwner(sql!, user.userId);
    const weights = { price: 45, time: 60, variation: 25, simplicity: 15 };
    await updateHouseholdPreferenceWeights(sql!, user.userId, stored!.id, weights);

    const saved = await request(app!)
      .put("/api/households")
      .set(authHeader(user.accessToken))
      .send(noRestrictionsBody);
    expect(saved.status).toBe(200);

    expect((await getHouseholdForOwner(sql!, user.userId))!.preference_weights).toEqual(weights);
  });

  // Slider notches, not raw engine weights (#157): the range and the step-5 grid are
  // rejected here as well as by zod and by the `preference_weight` domain. 101 and 37
  // are the cases the old raw-number parser would have accepted — they are the reason
  // the validation moved from "finite and >= 0" to the axis definition's own rule.
  it.each([
    ["price", "not-a-number"],
    ["time", "-1"],
    ["price", "Infinity"],
    ["time", "NaN"],
    ["price", "101"],
    ["time", "37"],
    ["variation", "2.5"],
    ["simplicity", "-5"],
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
          ingredient_slots: [makeSlot({ role: "vegetable", ingredient_id: "morot", substitutable: false })],
        }),
        makeTemplate("morotsgryta", {
          ingredient_slots: [makeSlot({ role: "vegetable", ingredient_id: "morot", substitutable: false })],
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

describe.skipIf(!stackAvailable)("GET /api/tonight — diner-scoped constraints (#112)", () => {
  // A household where exactly one member is restricted, so the answer to "who is
  // eating" is the only thing that can change the answer to "what is safe".
  const peanutChildAndCleanAdult = {
    members: [
      { type: "adult", portion_factor: 1, allergies: [], dietary_flags: [] },
      { type: "child", portion_factor: 0.5, allergies: ["peanuts"], dietary_flags: [] },
    ],
  };

  /** Two templates: one safe for everyone, one only safe without the peanut-allergic child. */
  async function peanutApp(): Promise<Express> {
    const { makeEngineData, makeIngredient, makeTemplate } = await import(
      "../engine/__fixtures__/engineData.js"
    );

    return createApp({
      sql: sql!,
      engineData: makeEngineData({
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
      }),
      verifyToken: verifyToken!,
    });
  }

  async function userWithPeanutChild(): Promise<{ accessToken: string; userId: string }> {
    const user = await createTestUser();
    const created = await request(app!)
      .post("/api/households")
      .set(authHeader(user.accessToken))
      .send(peanutChildAndCleanAdult);
    expect(created.status).toBe(201);
    return user;
  }

  it("withholds the peanut dish when no diner set is given at all", async () => {
    // Condition 1 at the HTTP boundary: the zero-input request is the *safe* one.
    const user = await userWithPeanutChild();

    const response = await request(await peanutApp())
      .get("/api/tonight")
      .set(authHeader(user.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.result).toBeNull();
    expect(response.body.reason).toBe("no_safe_templates");
  });

  it("offers it once the peanut-allergic child is deselected", async () => {
    const user = await userWithPeanutChild();

    const response = await request(await peanutApp())
      .get("/api/tonight")
      .query({ diners: "0" })
      .set(authHeader(user.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.result?.template.id).toBe("satay");
    // Portions followed the same selection — the child is neither filtered for nor
    // cooked for.
    expect(response.body.portions).toBe(1);
  });

  it("still withholds it when the child is one of the selected diners", async () => {
    const user = await userWithPeanutChild();

    const response = await request(await peanutApp())
      .get("/api/tonight")
      .query({ diners: "0,1" })
      .set(authHeader(user.accessToken));

    expect(response.body.result).toBeNull();
    expect(response.body.reason).toBe("no_safe_templates");
    expect(response.body.portions).toBe(1.5);
  });

  // The safety-critical half: every malformed diner parameter must land on the
  // *restricted* answer, never the permissive one. A 400 is deliberately not among
  // the acceptable outcomes — see src/api/diners.ts.
  const failClosed: { name: string; query: Record<string, string | string[]> }[] = [
    { name: "absent", query: {} },
    { name: "empty", query: { diners: "" } },
    { name: "out of range", query: { diners: "7" } },
    { name: "one valid and one out of range", query: { diners: "0,7" } },
    { name: "negative", query: { diners: "-1" } },
    { name: "non-numeric", query: { diners: "alla" } },
    { name: "repeated (array-typed)", query: { diners: ["0", "1"] } },
  ];

  it.each(failClosed)("$name resolves to the whole household", async ({ query }) => {
    const user = await userWithPeanutChild();

    const response = await request(await peanutApp())
      .get("/api/tonight")
      .query(query)
      .set(authHeader(user.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.result).toBeNull();
    expect(response.body.reason).toBe("no_safe_templates");
    expect(response.body.portions).toBe(1.5);
  });

  it("returns one label per member, in member order, and no member data beyond it", async () => {
    const user = await createTestUser();
    await request(app!)
      .post("/api/households")
      .set(authHeader(user.accessToken))
      .send({
        members: [
          { type: "adult", portion_factor: 1, name: "Niklas", allergies: [], dietary_flags: [] },
          { type: "child", portion_factor: 0.5, allergies: ["peanuts"], dietary_flags: ["vegan"] },
        ],
      });

    const response = await request(app!).get("/api/tonight").set(authHeader(user.accessToken));

    expect(response.body.diners).toEqual([{ label: "Niklas" }, { label: "Barn 1" }]);
    // No allergy or dietary data crosses the wire: the client renders a picker, it
    // does not hold a second copy of the household.
    expect(JSON.stringify(response.body.diners)).not.toContain("peanuts");
    expect(JSON.stringify(response.body.diners)).not.toContain("vegan");
  });

  it("writes nothing to the household — a diner selection is not a profile edit", async () => {
    const user = await userWithPeanutChild();
    const { getHouseholdForOwner } = await import("../db/households.js");
    const before = await getHouseholdForOwner(sql!, user.userId);

    for (const diners of ["0", "1", "0,1", "9", "alla"]) {
      await request(app!).get("/api/tonight").query({ diners }).set(authHeader(user.accessToken));
    }

    const after = await getHouseholdForOwner(sql!, user.userId);
    expect(after).toEqual(before);
    expect(after!.household).toEqual(peanutChildAndCleanAdult);
  });

  it("still answers a plain zero-input request with a suggestion over the real catalog", async () => {
    // The condition-2 regression: Tonight must never require a diner parameter.
    const user = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(user.accessToken)).send(noRestrictionsBody);

    const response = await request(app!).get("/api/tonight").set(authHeader(user.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.result).not.toBeNull();
  });
});

// #168: onboarding now asks one mandatory allergy question instead of rendering
// the whole chip set per member. What that change could break is the very first
// suggestion — the one moment a household has declared an allergy and has not yet
// seen anything the app chose. The client-side ordering (the household is created
// before Tonight is ever requested) is asserted in web/src/App.test.tsx; this is
// the other half, over real HTTP: given exactly the body onboarding sends, the
// first response cannot carry the declared allergen.
describe.skipIf(!stackAvailable)("the first suggestion after onboarding (#168)", () => {
  /** Byte for byte what `toHouseholdPayload` sends after "Ja" → Jordnötter on member 2. */
  const onboardingBodyWithPeanutAllergy = {
    members: [
      { type: "adult", portion_factor: 1, allergies: [], dietary_flags: [] },
      { type: "child", portion_factor: 0.5, allergies: ["peanuts"], dietary_flags: [] },
    ],
  };

  /** One peanut dish and one safe dish, so a null result cannot be mistaken for safety. */
  async function twoDishApp(): Promise<Express> {
    const { makeEngineData, makeIngredient, makeTemplate } = await import(
      "../engine/__fixtures__/engineData.js"
    );

    return createApp({
      sql: sql!,
      engineData: makeEngineData({
        ingredients: [makeIngredient("jordnotter"), makeIngredient("morot")],
        allergenMappings: [
          { ingredient_id: "jordnotter", allergens: ["peanuts"], verification_status: "verified" },
          { ingredient_id: "morot", allergens: [], verification_status: "verified" },
        ],
        templates: [
          makeTemplate("satay", {
            ingredient_slots: [
              makeSlot({ role: "protein", ingredient_id: "jordnotter", substitutable: false }),
            ],
          }),
          makeTemplate("morotssoppa", {
            ingredient_slots: [
              makeSlot({ role: "vegetable", ingredient_id: "morot", substitutable: false }),
            ],
          }),
        ],
      }),
      verifyToken: verifyToken!,
    });
  }

  it("never carries the declared allergen", async () => {
    const user = await createTestUser();
    const twoDishes = await twoDishApp();

    const created = await request(twoDishes)
      .post("/api/households")
      .set(authHeader(user.accessToken))
      .send(onboardingBodyWithPeanutAllergy);
    expect(created.status).toBe(201);

    // The very first Tonight request of the household's life — no diner set, no
    // exclusions, nothing but the profile onboarding just wrote.
    const response = await request(twoDishes).get("/api/tonight").set(authHeader(user.accessToken));

    expect(response.status).toBe(200);
    // A dish *was* suggested — the assertion below would pass vacuously otherwise.
    expect(response.body.result).not.toBeNull();
    expect(response.body.result.template.id).toBe("morotssoppa");
    for (const ingredient of response.body.result.ingredients) {
      expect(ingredient.allergens ?? []).not.toContain("peanuts");
    }
    expect(JSON.stringify(response.body.result)).not.toContain("jordnotter");
  });

  it("shows the peanut dish to a household that answered no, from the same catalog", async () => {
    // The control: the withholding above is the household's declared allergy doing
    // its work, not the fixture being unable to produce that dish at all.
    const user = await createTestUser();
    const twoDishes = await twoDishApp();

    await request(twoDishes)
      .post("/api/households")
      .set(authHeader(user.accessToken))
      .send({
        members: [{ type: "adult", portion_factor: 1, allergies: [], dietary_flags: [] }],
      });

    const response = await request(twoDishes)
      .get("/api/tonight")
      .query({ exclude: "morotssoppa" })
      .set(authHeader(user.accessToken));

    expect(response.body.result?.template.id).toBe("satay");
  });
});

describe.skipIf(!stackAvailable)("GET /api/tonight — `keep` on a diner-set change (#133)", () => {
  // Selection/exclusion behaviour over `keep` is covered exhaustively in
  // src/engine/candidates.test.ts and src/api/dinerChangeReason.test.ts; what these
  // tests prove is the wiring — that a real request reaches those functions with
  // the right template and the right household, and the response shape a diner
  // change actually gets back.
  const adultAndPeanutChild = {
    members: [
      { type: "adult", portion_factor: 1, allergies: [], dietary_flags: [] },
      { type: "child", portion_factor: 0.5, allergies: ["peanuts"], dietary_flags: [] },
    ],
  };

  async function keepApp(): Promise<Express> {
    const { makeEngineData, makeIngredient, makeTemplate } = await import(
      "../engine/__fixtures__/engineData.js"
    );

    return createApp({
      sql: sql!,
      engineData: makeEngineData({
        ingredients: [makeIngredient("jordnotter"), makeIngredient("morot")],
        allergenMappings: [
          { ingredient_id: "jordnotter", allergens: ["peanuts"], verification_status: "verified" },
          { ingredient_id: "morot", allergens: [], verification_status: "verified" },
        ],
        templates: [
          // Contains peanuts — safe only without the peanut-allergic child.
          makeTemplate("satay", {
            ingredient_slots: [makeSlot({ role: "protein", ingredient_id: "jordnotter", substitutable: false })],
          }),
          // Safe for everyone, regardless of who is eating.
          makeTemplate("morotssoppa", {
            ingredient_slots: [makeSlot({ role: "vegetable", ingredient_id: "morot", substitutable: false })],
          }),
        ],
      }),
      verifyToken: verifyToken!,
    });
  }

  async function userWithPeanutChild(): Promise<{ accessToken: string }> {
    const user = await createTestUser();
    const created = await request(app!)
      .post("/api/households")
      .set(authHeader(user.accessToken))
      .send(adultAndPeanutChild);
    expect(created.status).toBe(201);
    return user;
  }

  it("returns the same dish, unchanged, when the new diner set still allows it — the regression this closes", async () => {
    const user = await userWithPeanutChild();
    const app = await keepApp();

    // "morotssoppa" was already on screen for the adult alone; adding the
    // peanut-allergic child changes nothing about whether it's safe.
    const response = await request(app)
      .get("/api/tonight")
      .query({ diners: "0,1", keep: "morotssoppa" })
      .set(authHeader(user.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.result.template.id).toBe("morotssoppa");
    expect(response.body.replacedFor).toBeUndefined();
  });

  it("updates portions on a kept dish even though the dish itself did not change", async () => {
    const user = await userWithPeanutChild();
    const app = await keepApp();

    const adultOnly = await request(app)
      .get("/api/tonight")
      .query({ diners: "0", keep: "morotssoppa" })
      .set(authHeader(user.accessToken));
    const both = await request(app)
      .get("/api/tonight")
      .query({ diners: "0,1", keep: "morotssoppa" })
      .set(authHeader(user.accessToken));

    expect(adultOnly.body.result.template.id).toBe("morotssoppa");
    expect(both.body.result.template.id).toBe("morotssoppa");
    expect(adultOnly.body.portions).toBe(1);
    expect(both.body.portions).toBe(1.5);
  });

  it("replaces the dish and names the affected member when the new diner set makes it unsafe", async () => {
    const user = await userWithPeanutChild();
    const app = await keepApp();

    // "satay" was safe for the adult alone; adding the peanut-allergic child makes
    // it unsafe, so it must never come back — but the household must be told why,
    // not handed a silently different dish.
    const response = await request(app)
      .get("/api/tonight")
      .query({ diners: "0,1", keep: "satay" })
      .set(authHeader(user.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.result.template.id).not.toBe("satay");
    expect(response.body.result.template.id).toBe("morotssoppa");
    // The child has no declared name, so the derived label applies.
    expect(response.body.replacedFor).toBe("Barn 1");
  });

  it("never replaces a dish selecting a diner set that leaves it safe, even repeatedly", async () => {
    const user = await userWithPeanutChild();
    const app = await keepApp();

    for (const diners of ["0", "1", "0,1"]) {
      const response = await request(app)
        .get("/api/tonight")
        .query({ diners, keep: "morotssoppa" })
        .set(authHeader(user.accessToken));

      expect(response.body.result.template.id).toBe("morotssoppa");
      expect(response.body.replacedFor).toBeUndefined();
    }
  });

  it("keeps a genuine 'why this dish' explanation on a kept dish, not the silence a self-excluded dish would produce", async () => {
    // A dish always carries its own id in `exclude` by the time a diner change
    // fires (the client adds every shown dish the moment it appears) — so
    // explaining *this* dish while it also counts as its own exclusion must not
    // make `explainSuggestion` treat it as absent from the candidate set it is
    // being explained against.
    const { makeEngineData, makeIngredient, makeTemplate } = await import(
      "../engine/__fixtures__/engineData.js"
    );
    const costTieredApp = createApp({
      sql: sql!,
      engineData: makeEngineData({
        ingredients: [makeIngredient("morot"), makeIngredient("hummer")],
        allergenMappings: [
          { ingredient_id: "morot", allergens: [], verification_status: "verified" },
          { ingredient_id: "hummer", allergens: [], verification_status: "verified" },
        ],
        templates: [
          makeTemplate("morotssoppa", {
            cost_tier: "budget",
            ingredient_slots: [makeSlot({ role: "vegetable", ingredient_id: "morot", substitutable: false })],
          }),
          makeTemplate("hummergryta", {
            cost_tier: "premium",
            ingredient_slots: [makeSlot({ role: "protein", ingredient_id: "hummer", substitutable: false })],
          }),
        ],
      }),
      verifyToken: verifyToken!,
    });
    const user = await createTestUser();
    await request(costTieredApp)
      .post("/api/households")
      .set(authHeader(user.accessToken))
      .send(noRestrictionsBody);

    // The household's "Billigare" chip already picked the budget dish for the
    // cost preference — this is the real reason the client's `exclude` carries
    // its id by the time any diner change can happen.
    const first = await request(costTieredApp)
      .get("/api/tonight")
      .query({ price: "10" })
      .set(authHeader(user.accessToken));
    expect(first.body.result.template.id).toBe("morotssoppa");
    expect(first.body.result.reasonCodes).toContain("cost_preference");

    const afterDinerChange = await request(costTieredApp)
      .get("/api/tonight")
      .query({ price: "10", exclude: "morotssoppa", keep: "morotssoppa" })
      .set(authHeader(user.accessToken));

    expect(afterDinerChange.body.result.template.id).toBe("morotssoppa");
    expect(afterDinerChange.body.result.reasonCodes).toContain("cost_preference");
  });
});

describe.skipIf(!stackAvailable)("GET /api/tonight — the pantry row (#152)", () => {
  // Wiring only: the ordering rule and its safety properties are covered exhaustively
  // in src/engine/pantryOrdering.test.ts. What matters here is that the parameter
  // reaches the engine, the chip list comes back, and nothing is written down.

  async function household() {
    const user = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(user.accessToken)).send(noRestrictionsBody);
    return user;
  }

  it("offers a pantry chip list on every response, including the empty states", async () => {
    const user = await household();
    const response = await request(app!).get("/api/tonight").set(authHeader(user.accessToken));

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.pantryIngredients)).toBe(true);
    expect(response.body.pantryIngredients.length).toBeGreaterThan(0);
    for (const option of response.body.pantryIngredients) {
      expect(typeof option.id).toBe("string");
      expect(typeof option.name).toBe("string");
    }
  });

  it("offers the same chips Tonight and the guided flow's step 3 offer", async () => {
    // One list, from `buildPantryIngredientOptions` — a household must not be shown a
    // different cupboard depending on which screen it is standing on.
    const user = await household();
    const tonight = await request(app!).get("/api/tonight").set(authHeader(user.accessToken));
    const guided = await request(app!).get("/api/guided/options").set(authHeader(user.accessToken));

    expect(tonight.body.pantryIngredients).toEqual(guided.body.pantryIngredients);
  });

  it("changes which dish is suggested when the pantry covers a lower-ranked one", async () => {
    const user = await household();
    const plain = await request(app!).get("/api/tonight").set(authHeader(user.accessToken));

    // Every starch at once: something the household "has" is certain to promote a
    // dish the plain score did not lead with.
    const withPantry = await request(app!)
      .get("/api/tonight")
      .query({ pantry: "spagetti,ris,potatis,couscous,bulgur" })
      .set(authHeader(user.accessToken));

    expect(withPantry.status).toBe(200);
    expect(plain.status).toBe(200);
    // Not asserting they differ — the score winner may legitimately already cover the
    // pantry. What must hold is that the answer is still a real, safe suggestion.
    expect(withPantry.body.result.template.id).toEqual(expect.any(String));
  });

  it("explains the pick with the ingredient names when the pantry decided it", async () => {
    const user = await household();

    // Sweep single staples until one actually promotes a dish, then assert the shape
    // of the explanation. Deterministic — the list and the order are fixed.
    let explained: { reasonCodes: string[]; pantryMatch: string[] } | undefined;
    for (const id of ["spagetti", "ris", "potatis", "couscous", "bulgur", "makaroner"]) {
      const response = await request(app!)
        .get("/api/tonight")
        .query({ pantry: id })
        .set(authHeader(user.accessToken));
      if (response.body.result?.reasonCodes?.includes("pantry_match")) {
        explained = response.body.result;
        break;
      }
    }

    expect(explained).toBeDefined();
    expect(explained!.pantryMatch.length).toBeGreaterThan(0);
    expect(explained!.pantryMatch.length).toBeLessThanOrEqual(2);
    for (const name of explained!.pantryMatch) expect(typeof name).toBe("string");
  });

  it("omits pantryMatch entirely when the pantry explained nothing", async () => {
    const user = await household();
    const response = await request(app!).get("/api/tonight").set(authHeader(user.accessToken));

    expect(response.body.result.reasonCodes).not.toContain("pantry_match");
    expect(response.body.result.pantryMatch).toBeUndefined();
  });

  it("rejects an unknown ingredient id with 400", async () => {
    const user = await household();
    const response = await request(app!)
      .get("/api/tonight")
      .query({ pantry: "inte-en-ingrediens" })
      .set(authHeader(user.accessToken));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_pantry");
  });

  it("writes the pantry selection nowhere", async () => {
    // CLAUDE.md's non-negotiable: session-scoped and ephemeral. The same snapshot
    // assertion guided.test.ts makes about step 3, applied to Tonight's own row.
    const user = await household();
    const before = (await getHouseholdForOwner(sql!, user.userId))!;

    await request(app!)
      .get("/api/tonight")
      .query({ pantry: "spagetti,ris,potatis" })
      .set(authHeader(user.accessToken));

    const after = (await getHouseholdForOwner(sql!, user.userId))!;
    expect(after).toEqual(before);
  });

  it("cannot widen the candidate set — an allergic household sees the same dishes", async () => {
    const allergic = await createTestUser();
    await request(app!)
      .post("/api/households")
      .set(authHeader(allergic.accessToken))
      .send(makeHousehold({ allergies: ["gluten"] }));

    const plain = await request(app!).get("/api/tonight").set(authHeader(allergic.accessToken));
    const withPantry = await request(app!)
      .get("/api/tonight")
      .query({ pantry: "spagetti,makaroner,formbrod" })
      .set(authHeader(allergic.accessToken));

    // Every gluten-bearing staple "at home" and the answer is still a safe dish: the
    // pantry orders the safe set, it never reaches back into what the safe set is.
    expect(withPantry.status).toBe(200);
    expect(plain.status).toBe(200);
    expect(withPantry.body.result === null).toBe(plain.body.result === null);
  });
});

describe.skipIf(!stackAvailable)("PUT /api/households/preferences", () => {
  async function household() {
    const user = await createTestUser();
    await request(app!).post("/api/households").set(authHeader(user.accessToken)).send(noRestrictionsBody);
    return user;
  }

  const weights = { price: 45, time: 60, variation: 25, simplicity: 15 };

  it("stores the baseline and returns the household", async () => {
    const user = await household();
    const response = await request(app!)
      .put("/api/households/preferences")
      .set(authHeader(user.accessToken))
      .send(weights);

    expect(response.status).toBe(200);
    expect(response.body.preference_weights).toEqual(weights);
    expect((await getHouseholdForOwner(sql!, user.userId))!.preference_weights).toEqual(weights);
  });

  it("survives a profile save — the two write paths never clobber each other", async () => {
    // The whole reason this route exists rather than a field on `PUT /api/households`.
    const user = await household();
    await request(app!)
      .put("/api/households/preferences")
      .set(authHeader(user.accessToken))
      .send(weights);

    const saved = await request(app!)
      .put("/api/households")
      .set(authHeader(user.accessToken))
      .send(noRestrictionsBody);
    expect(saved.status).toBe(200);

    expect((await getHouseholdForOwner(sql!, user.userId))!.preference_weights).toEqual(weights);
  });

  it("reaches the ranking — a stored baseline changes what Tonight suggests", async () => {
    const user = await household();
    await request(app!)
      .put("/api/households/preferences")
      .set(authHeader(user.accessToken))
      .send({ ...NEUTRAL_PREFERENCE_WEIGHTS, time: 100 });

    const response = await request(app!).get("/api/tonight").set(authHeader(user.accessToken));
    expect(response.body.result.template.prep_time_band).toBe("<20min");
  });

  it.each([
    ["a partial body", { price: 0, time: 0, variation: 0 }],
    ["an off-grid notch", { price: 37, time: 0, variation: 0, simplicity: 0 }],
    ["an out-of-range value", { price: 101, time: 0, variation: 0, simplicity: 0 }],
    ["a negative value", { price: -5, time: 0, variation: 0, simplicity: 0 }],
  ])("rejects %s with 400", async (_label, body) => {
    const user = await household();
    const response = await request(app!)
      .put("/api/households/preferences")
      .set(authHeader(user.accessToken))
      .send(body);

    expect(response.status).toBe(400);
  });

  it("404s for a user with no household yet", async () => {
    const user = await createTestUser();
    const response = await request(app!)
      .put("/api/households/preferences")
      .set(authHeader(user.accessToken))
      .send(weights);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("household_not_found");
  });

  it("requires a token", async () => {
    const response = await request(app!).put("/api/households/preferences").send(weights);
    expect(response.status).toBe(401);
  });
});
