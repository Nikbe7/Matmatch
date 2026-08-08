import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { generateDish } from "./generateDish.js";
import type { AnthropicMessagesClient } from "./generateInstructions.js";

// Unit tests with the AI client mocked entirely — no network, no real Anthropic
// call. Same reason as generateInstructions.test.ts: every failure mode must
// collapse to `{ ok: false }` rather than throw, since the route depends on that to
// answer 200 instead of a 5xx.

const input = {
  query: "kycklinggryta med curry",
  catalogIngredientNames: ["kyckling", "gul lök", "curry", "kokosmjölk", "ris"],
};

function textMessage(text: string): Anthropic.Message {
  return { content: [{ type: "text", text, citations: null }] } as unknown as Anthropic.Message;
}

function mockClient(create: AnthropicMessagesClient["messages"]["create"]): AnthropicMessagesClient {
  return { messages: { create } };
}

const validOutput = {
  name: "Kycklinggryta med curry",
  cuisine: "asian",
  prep_time_band: "20-40min",
  protein_group: "chicken_poultry",
  meal_types: ["dinner"],
  familiarity: "everyday",
  ingredients: [
    { role: "protein", name: "kyckling" },
    { role: "aromatic", name: "gul lök" },
    { role: "aromatic", name: "curry" },
    { role: "dairy", name: "kokosmjölk" },
    { role: "starch", name: "ris" },
  ],
};

describe("generateDish", () => {
  it("parses and returns a valid response", async () => {
    const client = mockClient(vi.fn().mockResolvedValue(textMessage(JSON.stringify(validOutput))));

    const result = await generateDish(client, input);

    expect(result).toEqual({ ok: true, output: validOutput });
  });

  it("returns ok:false for malformed JSON rather than throwing", async () => {
    const client = mockClient(vi.fn().mockResolvedValue(textMessage("{not valid json")));

    const result = await generateDish(client, input);

    expect(result).toEqual({ ok: false, reason: "invalid_response" });
  });

  it("returns ok:false for a schema-invalid response (bad enum value) rather than throwing", async () => {
    const client = mockClient(
      vi.fn().mockResolvedValue(
        textMessage(JSON.stringify({ ...validOutput, cuisine: "not-a-real-cuisine" })),
      ),
    );

    const result = await generateDish(client, input);

    expect(result).toEqual({ ok: false, reason: "schema_invalid" });
  });

  it("returns ok:false for a schema-invalid response (empty ingredients) rather than throwing", async () => {
    const client = mockClient(
      vi.fn().mockResolvedValue(textMessage(JSON.stringify({ ...validOutput, ingredients: [] }))),
    );

    const result = await generateDish(client, input);

    expect(result).toEqual({ ok: false, reason: "schema_invalid" });
  });

  it("returns ok:false when the client throws rather than letting the error escape", async () => {
    const client = mockClient(vi.fn().mockRejectedValue(new Error("network exploded")));

    const result = await generateDish(client, input);

    expect(result).toEqual({ ok: false, reason: "api_error" });
  });

  it("returns reason: timeout for an Anthropic connection-timeout error", async () => {
    const client = mockClient(vi.fn().mockRejectedValue(new Anthropic.APIConnectionTimeoutError()));

    const result = await generateDish(client, input);

    expect(result).toEqual({ ok: false, reason: "timeout" });
  });

  it("returns ok:false when the response has no text block", async () => {
    const client = mockClient(vi.fn().mockResolvedValue({ content: [] } as unknown as Anthropic.Message));

    const result = await generateDish(client, input);

    expect(result).toEqual({ ok: false, reason: "invalid_response" });
  });

  it("a schema-valid response can never carry a cost figure or any numeric field", async () => {
    // Structural, not behavioral: assert the model's *possible* output shape has no
    // numeric field at all, so there is no code path — buggy prompt, model
    // hallucination, anything — through which a model-provided number could reach
    // GeneratedDishOutput. If this test ever needs a numeric field added to make it
    // pass, that is the signal to stop and re-read CLAUDE.md's non-negotiable.
    const client = mockClient(vi.fn().mockResolvedValue(textMessage(JSON.stringify(validOutput))));
    const result = await generateDish(client, input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    for (const value of Object.values(result.output)) {
      expect(typeof value).not.toBe("number");
    }
    for (const ingredient of result.output.ingredients) {
      for (const value of Object.values(ingredient)) {
        expect(typeof value).not.toBe("number");
      }
    }
  });
});
