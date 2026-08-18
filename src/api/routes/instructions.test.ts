import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnthropicMessagesClient } from "../../ai/generateInstructions.js";
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
import type { EngineData } from "../../engine/data.js";
import { createApp } from "../app.js";
import { buildSubstitutionKey, insertCachedInstructions } from "../../db/recipeInstructions.js";

// Integration tests against the real local Supabase stack, mirroring app.test.ts's
// pattern — real DB, real auth, but a mocked Anthropic client so the suite never
// makes a real (billed) API call. What this file proves: the cache is checked
// before any AI call, a miss calls the AI exactly once and caches the result, a
// different substitution set is a genuinely different cache entry, and every AI
// failure mode (including "no key configured at all") answers 200 with
// instructions: null rather than a 5xx.
//
// The cache table is real and not cleaned up between test runs, so every test that
// writes to it uses a fresh, randomly-generated template id (buildFixture()) rather
// than a shared one — otherwise a row left over from a previous run of this same
// file would silently satisfy a later run's "cache miss" expectation.

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

/** A fresh template id + matching EngineData, so cache-table state never leaks
 * across tests or across repeated runs of this file. */
function buildFixture(): { engineData: EngineData; templateId: string } {
  const templateId = `test-kycklinggryta-${crypto.randomUUID()}`;
  const engineData = makeEngineData({
    ingredients: [makeIngredient("kyckling"), makeIngredient("tofu"), makeIngredient("morot")],
    templates: [
      makeTemplate(templateId, {
        cuisine: "swedish_nordic",
        prep_time_band: "20-40min",
        ingredient_slots: [
          makeSlot({ role: "protein", ingredient_id: "kyckling", substitutable: true }),
          makeSlot({ role: "vegetable", ingredient_id: "morot", substitutable: false }),
        ],
      }),
    ],
  });
  return { engineData, templateId };
}

const validSteps = ["Steg 1.", "Steg 2.", "Steg 3.", "Steg 4.", "Steg 5.", "Steg 6."];

// The fixture template holds kyckling + morot; tofu is in the catalog but not in the
// template, which makes it exactly the "ingredient the model invented" case (#154).
const cleanSteps = [
  "Skär kycklingen i bitar.",
  "Skala och tärna moroten.",
  "Hetta upp en stekpanna.",
  "Bryn kycklingen på hög värme.",
  "Tillsätt moroten och fräs kort.",
  "Låt allt sjuda tills kycklingen är genomstekt.",
];
const foreignSteps = [...cleanSteps.slice(0, 5), "Rör ner tofu och låt det bli varmt."];
const quantitySteps = [...cleanSteps.slice(0, 5), "Tillsätt 300 g morot och rör om."];

function textResponse(steps: string[]) {
  return { content: [{ type: "text", text: JSON.stringify({ steps }) }] } as never;
}

function buildApp(engineData: EngineData, anthropicClient: AnthropicMessagesClient | undefined): Express {
  return createApp({ sql: sql!, engineData, verifyToken: verifyToken!, anthropicClient });
}

describe.skipIf(!stackAvailable)("POST /api/instructions", () => {
  it("returns 401 without a token", async () => {
    const { engineData, templateId } = buildFixture();
    const app = buildApp(engineData, undefined);

    const response = await request(app).post("/api/instructions").send({ templateId });

    expect(response.status).toBe(401);
  });

  it("returns 404 for an unknown template id", async () => {
    const { engineData } = buildFixture();
    const app = buildApp(engineData, undefined);
    const user = await createTestUser();

    const response = await request(app)
      .post("/api/instructions")
      .set(authHeader(user.accessToken))
      .send({ templateId: "not-a-real-template" });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("template_not_found");
  });

  it("returns 400 for a substitution slot_index that doesn't exist on the template", async () => {
    const { engineData, templateId } = buildFixture();
    const app = buildApp(engineData, undefined);
    const user = await createTestUser();

    const response = await request(app)
      .post("/api/instructions")
      .set(authHeader(user.accessToken))
      .send({ templateId, substitutions: [{ slot_index: 9, substitute_ingredient_id: "tofu" }] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_substitution");
  });

  it("returns 400 for a substitution naming an ingredient outside the catalog", async () => {
    const { engineData, templateId } = buildFixture();
    const app = buildApp(engineData, undefined);
    const user = await createTestUser();

    const response = await request(app)
      .post("/api/instructions")
      .set(authHeader(user.accessToken))
      .send({
        templateId,
        substitutions: [{ slot_index: 0, substitute_ingredient_id: "not-a-real-ingredient" }],
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_substitution");
  });

  it("returns instructions: null with reason ai_not_configured when no client is wired — never a 5xx", async () => {
    const { engineData, templateId } = buildFixture();
    const app = buildApp(engineData, undefined);
    const user = await createTestUser();

    const response = await request(app)
      .post("/api/instructions")
      .set(authHeader(user.accessToken))
      .send({ templateId, substitutions: [] });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ instructions: null, reason: "ai_not_configured" });
  });

  it("returns instructions: null with a reason when the AI call fails — never a 5xx", async () => {
    const { engineData, templateId } = buildFixture();
    const create = vi.fn().mockRejectedValue(new Error("boom"));
    const app = buildApp(engineData, { messages: { create } });
    const user = await createTestUser();

    const response = await request(app)
      .post("/api/instructions")
      .set(authHeader(user.accessToken))
      .send({ templateId, substitutions: [{ slot_index: 0, substitute_ingredient_id: "tofu" }] });

    expect(response.status).toBe(200);
    expect(response.body.instructions).toBeNull();
    expect(typeof response.body.reason).toBe("string");
  });

  describe("caching", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("calls the AI client on a cache miss, caches the result, then serves the next identical request from cache", async () => {
      const { engineData, templateId } = buildFixture();
      const create = vi.fn().mockResolvedValue(textResponse(validSteps));
      const app = buildApp(engineData, { messages: { create } });
      const user = await createTestUser();
      const body = { templateId, substitutions: [{ slot_index: 0, substitute_ingredient_id: "kyckling" }] };

      const first = await request(app).post("/api/instructions").set(authHeader(user.accessToken)).send(body);
      expect(first.status).toBe(200);
      expect(first.body.instructions).toEqual(validSteps);
      expect(create).toHaveBeenCalledTimes(1);

      const second = await request(app).post("/api/instructions").set(authHeader(user.accessToken)).send(body);
      expect(second.status).toBe(200);
      expect(second.body.instructions).toEqual(validSteps);
      // The cache hit must not call the AI client again.
      expect(create).toHaveBeenCalledTimes(1);
    });

    it("does not cache — and so regenerates — a result that failed validation", async () => {
      const { engineData, templateId } = buildFixture();
      const create = vi
        .fn()
        .mockResolvedValueOnce(textResponse(foreignSteps))
        .mockResolvedValueOnce(textResponse(foreignSteps))
        .mockResolvedValue(textResponse(cleanSteps));
      const app = buildApp(engineData, { messages: { create } });
      const user = await createTestUser();
      const body = { templateId, substitutions: [] };

      const rejected = await request(app).post("/api/instructions").set(authHeader(user.accessToken)).send(body);
      expect(rejected.body.instructions).toBeNull();
      expect(create).toHaveBeenCalledTimes(2);

      // Nothing was written, so the next request is still a miss and reaches the AI
      // again — the cache must never hold content the validator rejected.
      const retried = await request(app).post("/api/instructions").set(authHeader(user.accessToken)).send(body);
      expect(retried.body.instructions).toEqual(cleanSteps);
      expect(create).toHaveBeenCalledTimes(3);
    });

    it("makes a fresh AI call for a different substitution set on the same template", async () => {
      const { engineData, templateId } = buildFixture();
      const create = vi.fn().mockResolvedValue(textResponse(validSteps));
      const app = buildApp(engineData, { messages: { create } });
      const user = await createTestUser();

      const noSub = await request(app)
        .post("/api/instructions")
        .set(authHeader(user.accessToken))
        .send({ templateId, substitutions: [] });
      expect(noSub.status).toBe(200);
      expect(create).toHaveBeenCalledTimes(1);

      const swapped = await request(app)
        .post("/api/instructions")
        .set(authHeader(user.accessToken))
        .send({
          templateId,
          substitutions: [{ slot_index: 0, substitute_ingredient_id: "tofu" }],
        });
      expect(swapped.status).toBe(200);
      // Different substitution set → different cache key → a second real call.
      expect(create).toHaveBeenCalledTimes(2);
    });
  });

  // The deterministic gate between the model and the household (#154). The unit
  // coverage for *what* counts as a violation lives in ai/instructionsValidation.test.ts;
  // what these prove is the route's contract around it — one retry, no caching of
  // rejected content, and a 200 with a null result rather than a 5xx.
  describe("validation", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("regenerates once when the first result names an ingredient outside the template", async () => {
      const { engineData, templateId } = buildFixture();
      const create = vi
        .fn()
        .mockResolvedValueOnce(textResponse(foreignSteps))
        .mockResolvedValueOnce(textResponse(cleanSteps));
      const app = buildApp(engineData, { messages: { create } });
      const user = await createTestUser();

      const response = await request(app)
        .post("/api/instructions")
        .set(authHeader(user.accessToken))
        .send({ templateId, substitutions: [] });

      expect(response.status).toBe(200);
      expect(response.body.instructions).toEqual(cleanSteps);
      expect(create).toHaveBeenCalledTimes(2);
    });

    it("gives up after the second rejection rather than retrying forever", async () => {
      const { engineData, templateId } = buildFixture();
      const create = vi.fn().mockResolvedValue(textResponse(foreignSteps));
      const app = buildApp(engineData, { messages: { create } });
      const user = await createTestUser();

      const response = await request(app)
        .post("/api/instructions")
        .set(authHeader(user.accessToken))
        .send({ templateId, substitutions: [] });

      expect(response.status).toBe(200);
      expect(response.body.instructions).toBeNull();
      expect(response.body.reason).toBe("validation_failed");
      expect(create).toHaveBeenCalledTimes(2);
    });

    it("rejects a model-written amount the same way — no number reaches the screen", async () => {
      const { engineData, templateId } = buildFixture();
      const create = vi.fn().mockResolvedValue(textResponse(quantitySteps));
      const app = buildApp(engineData, { messages: { create } });
      const user = await createTestUser();

      const response = await request(app)
        .post("/api/instructions")
        .set(authHeader(user.accessToken))
        .send({ templateId, substitutions: [] });

      expect(response.body.instructions).toBeNull();
      expect(response.body.reason).toBe("validation_failed");
    });

    it("does not serve a cached row that fails validation — it regenerates and replaces it", async () => {
      const { engineData, templateId } = buildFixture();
      const create = vi.fn().mockResolvedValue(textResponse(cleanSteps));
      const app = buildApp(engineData, { messages: { create } });
      const user = await createTestUser();

      // A row as it could have been written before this validator existed: the cache
      // table predates #154 and its key carries no validator version, so a hit is
      // scanned like anything else rather than trusted.
      await insertCachedInstructions(sql!, templateId, buildSubstitutionKey([]), foreignSteps);

      const response = await request(app)
        .post("/api/instructions")
        .set(authHeader(user.accessToken))
        .send({ templateId, substitutions: [] });

      expect(response.body.instructions).toEqual(cleanSteps);
      expect(create).toHaveBeenCalledTimes(1);

      // Replaced, not merely bypassed — otherwise every later request would discard
      // and regenerate the same bad row forever.
      const second = await request(app)
        .post("/api/instructions")
        .set(authHeader(user.accessToken))
        .send({ templateId, substitutions: [] });
      expect(second.body.instructions).toEqual(cleanSteps);
      expect(create).toHaveBeenCalledTimes(1);
    });

    it("accepts an ingredient the request substituted in, not just the template's own", async () => {
      const { engineData, templateId } = buildFixture();
      // Slot 0 swapped kyckling → tofu, so a step naming tofu is now correct and a
      // step naming kyckling is the foreign one. The allow-list has to follow the
      // substitution, or every swapped dish would fail to generate.
      const tofuSteps = [
        "Skala och tärna moroten.",
        "Skär tofun i tärningar.",
        "Hetta upp en stekpanna.",
        "Stek tofun tills den fått färg.",
        "Tillsätt moroten och fräs kort.",
        "Låt allt sjuda några minuter.",
      ];
      const create = vi.fn().mockResolvedValue(textResponse(tofuSteps));
      const app = buildApp(engineData, { messages: { create } });
      const user = await createTestUser();

      const response = await request(app)
        .post("/api/instructions")
        .set(authHeader(user.accessToken))
        .send({ templateId, substitutions: [{ slot_index: 0, substitute_ingredient_id: "tofu" }] });

      expect(response.body.instructions).toEqual(tofuSteps);
      expect(create).toHaveBeenCalledTimes(1);
    });
  });
});
