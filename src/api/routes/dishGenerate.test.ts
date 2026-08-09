import express, { type Express } from "express";
import request from "supertest";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AnthropicMessagesClient } from "../../ai/generateInstructions.js";
import { createTokenVerifier } from "../../auth/verifyToken.js";
import type { Sql } from "../../db/client.js";
import type { Allergy, DietaryFlag } from "../../schema/allergyDietary.js";
import { createHousehold } from "../../db/households.js";
import { recordGenerationAttempt } from "../../db/generatedDishes.js";
import {
  LOCAL_ISSUER,
  LOCAL_JWKS_URL,
  appClient,
  createTestUser,
  isLocalStackAvailable,
} from "../../db/__fixtures__/localStack.js";
import { makeEngineData, makeIngredient } from "../../engine/__fixtures__/engineData.js";
import type { EngineData } from "../../engine/data.js";
import type { Household } from "../../schema/household.js";
import { createApp } from "../app.js";
import { dishGenerateRouter } from "./dishGenerate.js";

// Integration tests against the real local Supabase stack, mirroring
// instructions.test.ts's pattern: real DB, real auth, a mocked Anthropic client so
// the suite never makes a real (billed) API call. The generated_dishes and
// dish_generation_attempts tables are real and not cleaned up between runs, so
// every test uses a fresh, randomly-generated query rather than a shared one.

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

// Keeps the pre-#115 `{ allergies, dietary_flags }` call shape, landing them on the
// household's single adult member — see src/engine/__fixtures__/household.ts. Every
// expectation in this file is unchanged, which is the point.
async function userWithHousehold(
  memberOverrides: { allergies?: Allergy[]; dietary_flags?: DietaryFlag[] } = {},
): Promise<{
  userId: string;
  accessToken: string;
}> {
  const user = await createTestUser();
  await createHousehold(sql!, user.userId, {
    members: [
      {
        type: "adult",
        portion_factor: 1,
        allergies: memberOverrides.allergies ?? [],
        dietary_flags: memberOverrides.dietary_flags ?? [],
      },
    ],
  });
  return user;
}

/** A fresh catalog: peanuts-containing "jordnötssås" alongside safe ingredients. */
function buildEngineData(): EngineData {
  return makeEngineData({
    ingredients: [
      makeIngredient("kyckling", { name: "kyckling", default_cost_tier: "mid" }),
      makeIngredient("jordnotssas", { name: "jordnötssås", default_cost_tier: "premium" }),
      makeIngredient("jasminris", { name: "jasminris", category: "starch", default_cost_tier: "budget" }),
    ],
    allergenMappings: [
      { ingredient_id: "kyckling", allergens: [], verification_status: "verified" },
      { ingredient_id: "jordnotssas", allergens: ["peanuts"], verification_status: "verified" },
      { ingredient_id: "jasminris", allergens: [], verification_status: "verified" },
    ],
  });
}

function dishResponse(overrides: Record<string, unknown> = {}) {
  return {
    name: "Kyckling med jordnötssås",
    cuisine: "asian",
    prep_time_band: "20-40min",
    protein_group: "chicken_poultry",
    meal_types: ["dinner"],
    familiarity: "everyday",
    ingredients: [
      { role: "protein", name: "kyckling" },
      { role: "aromatic", name: "jordnötssås" },
      { role: "starch", name: "jasminris" },
    ],
    ...overrides,
  };
}

function textResponse(output: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(output) }] } as never;
}

function buildApp(engineData: EngineData, anthropicClient: AnthropicMessagesClient | undefined): Express {
  return createApp({ sql: sql!, engineData, verifyToken: verifyToken!, anthropicClient });
}

/**
 * Mounts only dishGenerateRouter directly (not the full createApp wiring), so a
 * test can inject a tiny daily ceiling — createApp always uses the production
 * default and has no test-only parameter to override it.
 */
function buildAppWithLimit(
  engineData: EngineData,
  anthropicClient: AnthropicMessagesClient | undefined,
  dailyGenerationLimit: number,
): Express {
  const app = express();
  app.use(express.json());
  app.use(dishGenerateRouter(sql!, engineData, verifyToken!, anthropicClient, dailyGenerationLimit));
  return app;
}

describe.skipIf(!stackAvailable)("POST /api/dishes/generate", () => {
  it("returns 401 without a token", async () => {
    const app = buildApp(buildEngineData(), undefined);

    const response = await request(app).post("/api/dishes/generate").send({ query: "kycklinggryta" });

    expect(response.status).toBe(401);
  });

  it("returns 404 when the user has no household yet", async () => {
    const app = buildApp(buildEngineData(), undefined);
    const user = await createTestUser();

    const response = await request(app)
      .post("/api/dishes/generate")
      .set(authHeader(user.accessToken))
      .send({ query: `never-cached-query-${crypto.randomUUID()}` });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("household_not_found");
  });

  it("returns 400 for an empty query", async () => {
    const app = buildApp(buildEngineData(), undefined);
    const user = await userWithHousehold();

    const response = await request(app)
      .post("/api/dishes/generate")
      .set(authHeader(user.accessToken))
      .send({ query: "   " });

    expect(response.status).toBe(400);
  });

  it("returns dish: null with reason ai_not_configured when no client is wired — never a 5xx", async () => {
    const app = buildApp(buildEngineData(), undefined);
    const user = await userWithHousehold();

    const response = await request(app)
      .post("/api/dishes/generate")
      .set(authHeader(user.accessToken))
      .send({ query: `never-cached-query-${crypto.randomUUID()}` });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ dish: null, reason: "ai_not_configured" });
  });

  it("returns dish: null with a reason when the AI call fails — never a 5xx", async () => {
    const create = vi.fn().mockRejectedValue(new Error("boom"));
    const app = buildApp(buildEngineData(), { messages: { create } });
    const user = await userWithHousehold();

    const response = await request(app)
      .post("/api/dishes/generate")
      .set(authHeader(user.accessToken))
      .send({ query: `never-cached-query-${crypto.randomUUID()}` });

    expect(response.status).toBe(200);
    expect(response.body.dish).toBeNull();
    expect(typeof response.body.reason).toBe("string");
  });

  it("degrades to generation_limit, never a 5xx or an unmetered call, once the daily ceiling is hit", async () => {
    const create = vi.fn().mockResolvedValue(textResponse(dishResponse()));
    const app = buildAppWithLimit(buildEngineData(), { messages: { create } }, 1);
    const user = await userWithHousehold();

    // Push the counter to the ceiling directly — the counter is a sliding 24h
    // window shared by the whole table, so one recorded attempt is enough against
    // a limit of 1.
    await recordGenerationAttempt(sql!);

    const response = await request(app)
      .post("/api/dishes/generate")
      .set(authHeader(user.accessToken))
      .send({ query: `never-cached-query-${crypto.randomUUID()}` });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ dish: null, reason: "generation_limit" });
    expect(create).not.toHaveBeenCalled();
  });

  describe("caching and cross-household safety", () => {
    it("calls the AI on a cache miss, caches the result, then serves the next identical query from cache", async () => {
      const create = vi.fn().mockResolvedValue(textResponse(dishResponse()));
      const app = buildApp(buildEngineData(), { messages: { create } });
      const user = await userWithHousehold();
      const query = `kycklinggryta med jordnötssås ${crypto.randomUUID()}`;

      const first = await request(app)
        .post("/api/dishes/generate")
        .set(authHeader(user.accessToken))
        .send({ query });
      expect(first.status).toBe(200);
      expect(create).toHaveBeenCalledTimes(1);

      const second = await request(app)
        .post("/api/dishes/generate")
        .set(authHeader(user.accessToken))
        .send({ query });
      expect(second.status).toBe(200);
      // The cache hit must not call the AI client again.
      expect(create).toHaveBeenCalledTimes(1);
    });

    it("a cache hit is withheld from a household with the dish's allergen but shown to one without it — same cached row, opposite outcomes", async () => {
      const engineData = buildEngineData();
      const create = vi.fn().mockResolvedValue(textResponse(dishResponse()));
      const app = buildApp(engineData, { messages: { create } });
      const query = `jordnötsgryta ${crypto.randomUUID()}`;

      const peanutHousehold = await userWithHousehold({ allergies: ["peanuts"] });
      const safeHousehold = await userWithHousehold({ allergies: [] });

      // First request (peanut-allergic household) is a cache miss: it generates and
      // writes the cache row, and must be withheld.
      const withheld = await request(app)
        .post("/api/dishes/generate")
        .set(authHeader(peanutHousehold.accessToken))
        .send({ query });
      expect(withheld.status).toBe(200);
      expect(withheld.body.dish).toBeNull();
      expect(withheld.body.reason).toBe("no_safe_dish");
      expect(create).toHaveBeenCalledTimes(1);

      // Second request (no allergies) reads the very same cached row — the AI is
      // not called again — and must see the dish. If the cache stored a
      // household-scoped decision instead of the raw model output, this would
      // incorrectly stay withheld.
      const shown = await request(app)
        .post("/api/dishes/generate")
        .set(authHeader(safeHousehold.accessToken))
        .send({ query });
      expect(shown.status).toBe(200);
      expect(shown.body.dish).not.toBeNull();
      expect(shown.body.dish.name).toBe("Kyckling med jordnötssås");
      expect(create).toHaveBeenCalledTimes(1);

      // And a repeat request from the originally-withheld household still comes
      // back withheld, off the same cache row — the cache crossing households
      // never changes *this* household's allergy outcome either.
      const stillWithheld = await request(app)
        .post("/api/dishes/generate")
        .set(authHeader(peanutHousehold.accessToken))
        .send({ query });
      expect(stillWithheld.body.dish).toBeNull();
      expect(create).toHaveBeenCalledTimes(1);
    });

    it("withholds an unresolved-ingredient dish from an allergic household but shows it, marked unverified, to one without allergies", async () => {
      const engineData = buildEngineData();
      const create = vi.fn().mockResolvedValue(
        textResponse(
          dishResponse({
            ingredients: [
              { role: "protein", name: "kyckling" },
              { role: "vegetable", name: "en ingrediens som inte finns i katalogen" },
            ],
          }),
        ),
      );
      const app = buildApp(engineData, { messages: { create } });
      const query = `okänd-ingrediens-rätt ${crypto.randomUUID()}`;

      const allergicHousehold = await userWithHousehold({ allergies: ["gluten"] });
      const withheld = await request(app)
        .post("/api/dishes/generate")
        .set(authHeader(allergicHousehold.accessToken))
        .send({ query });
      expect(withheld.body.dish).toBeNull();
      expect(withheld.body.reason).toBe("no_safe_dish");

      const safeHousehold = await userWithHousehold({ allergies: [] });
      const shown = await request(app)
        .post("/api/dishes/generate")
        .set(authHeader(safeHousehold.accessToken))
        .send({ query });
      expect(shown.body.dish).not.toBeNull();
      expect(shown.body.dish.unverified).toBe(true);
      expect(create).toHaveBeenCalledTimes(1);
    });

    it("withholds a generated dish from a household declaring vegetarian, since generated dishes never carry that tag", async () => {
      const engineData = buildEngineData();
      const create = vi.fn().mockResolvedValue(textResponse(dishResponse()));
      const app = buildApp(engineData, { messages: { create } });
      const query = `vegetarisk-fråga ${crypto.randomUUID()}`;
      const vegetarianHousehold = await userWithHousehold({ dietary_flags: ["vegetarian"] });

      const response = await request(app)
        .post("/api/dishes/generate")
        .set(authHeader(vegetarianHousehold.accessToken))
        .send({ query });

      expect(response.body.dish).toBeNull();
      expect(response.body.reason).toBe("no_safe_dish");
    });

    it("returns cost_tier derived from the catalog, and no numeric field anywhere in the response", async () => {
      const engineData = buildEngineData();
      const create = vi.fn().mockResolvedValue(textResponse(dishResponse()));
      const app = buildApp(engineData, { messages: { create } });
      const user = await userWithHousehold();
      const query = `kostnad-test ${crypto.randomUUID()}`;

      const response = await request(app)
        .post("/api/dishes/generate")
        .set(authHeader(user.accessToken))
        .send({ query });

      expect(response.status).toBe(200);
      expect(response.body.dish).not.toBeNull();
      // Highest tier among {kyckling: mid, jordnötssås: premium, jasminris: budget} is premium.
      expect(response.body.dish.cost_tier).toBe("premium");

      const assertNoNumbers = (value: unknown): void => {
        if (typeof value === "number") throw new Error("a numeric field reached the response");
        if (Array.isArray(value)) {
          value.forEach(assertNoNumbers);
        } else if (value && typeof value === "object") {
          Object.values(value).forEach(assertNoNumbers);
        }
      };
      assertNoNumbers(response.body);
    });
  });
});

describe.skipIf(!stackAvailable)("POST /api/dishes/generate — diner-scoped constraints (#112)", () => {
  // No user-facing surface sends `diners` yet (the search box is a later slice); this
  // proves the parameter is wired through the same seam as the other three endpoints
  // so the Tier 2 gate cannot drift from the curated library's filter.
  async function peanutChildHousehold() {
    const user = await createTestUser();
    await createHousehold(sql!, user.userId, {
      members: [
        { type: "adult", portion_factor: 1, allergies: [], dietary_flags: [] },
        { type: "child", portion_factor: 0.5, allergies: ["peanuts"], dietary_flags: [] },
      ],
    });
    return user;
  }

  it("withholds the peanut dish with no diner parameter and shows it once the child is deselected", async () => {
    const engineData = buildEngineData();
    const create = vi.fn().mockResolvedValue(textResponse(dishResponse()));
    const app = buildApp(engineData, { messages: { create } });
    const query = `jordnötsgryta ${crypto.randomUUID()}`;
    const user = await peanutChildHousehold();

    const withheld = await request(app)
      .post("/api/dishes/generate")
      .set(authHeader(user.accessToken))
      .send({ query });
    expect(withheld.body.dish).toBeNull();
    expect(withheld.body.reason).toBe("no_safe_dish");

    const shown = await request(app)
      .post(`/api/dishes/generate?diners=0`)
      .set(authHeader(user.accessToken))
      .send({ query });
    expect(shown.body.dish?.name).toBe("Kyckling med jordnötssås");
    // Same cached row, no second AI call — the safety decision was never cached.
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("fails closed on every malformed diner parameter", async () => {
    const engineData = buildEngineData();
    const create = vi.fn().mockResolvedValue(textResponse(dishResponse()));
    const app = buildApp(engineData, { messages: { create } });
    const query = `jordnötsgryta ${crypto.randomUUID()}`;
    const user = await peanutChildHousehold();

    for (const diners of ["", "9", "0,9", "-1", "alla"]) {
      const response = await request(app)
        .post(`/api/dishes/generate?diners=${encodeURIComponent(diners)}`)
        .set(authHeader(user.accessToken))
        .send({ query });

      expect(response.status).toBe(200);
      expect(response.body.dish).toBeNull();
      expect(response.body.reason).toBe("no_safe_dish");
    }
  });
});
