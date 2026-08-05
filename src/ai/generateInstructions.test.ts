import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { generateInstructions, type AnthropicMessagesClient } from "./generateInstructions.js";

// Unit tests with the AI client mocked entirely — no network, no real Anthropic
// call. What matters here is that every failure mode collapses to `{ ok: false }`
// rather than throwing, since the route depends on that to answer 200 instead of a
// 5xx (issue #78's "never a 5xx, never block the suggestion" requirement).

const input = {
  dishName: "Kycklinggryta",
  cuisine: "swedish_nordic" as const,
  prepTimeBand: "20-40min" as const,
  ingredients: [
    { role: "protein" as const, name: "Kyckling" },
    { role: "vegetable" as const, name: "Morot" },
  ],
};

function textMessage(text: string): Anthropic.Message {
  return { content: [{ type: "text", text, citations: null }] } as unknown as Anthropic.Message;
}

function mockClient(create: AnthropicMessagesClient["messages"]["create"]): AnthropicMessagesClient {
  return { messages: { create } };
}

const validSteps = [
  "Skär kycklingen i bitar.",
  "Skala och tärna moroten.",
  "Hetta upp olja i en gryta.",
  "Bryn kycklingen på hög värme.",
  "Tillsätt moroten och fräs kort.",
  "Låt allt sjuda tills kycklingen är genomstekt.",
];

describe("generateInstructions", () => {
  it("parses and returns a valid response", async () => {
    const client = mockClient(vi.fn().mockResolvedValue(textMessage(JSON.stringify({ steps: validSteps }))));

    const result = await generateInstructions(client, input);

    expect(result).toEqual({ ok: true, steps: validSteps });
  });

  it("returns ok:false for malformed JSON rather than throwing", async () => {
    const client = mockClient(vi.fn().mockResolvedValue(textMessage("{not valid json")));

    const result = await generateInstructions(client, input);

    expect(result).toEqual({ ok: false, reason: "invalid_response" });
  });

  it("returns ok:false for a schema-invalid response (too few steps) rather than throwing", async () => {
    const client = mockClient(
      vi.fn().mockResolvedValue(textMessage(JSON.stringify({ steps: ["Bara ett steg."] }))),
    );

    const result = await generateInstructions(client, input);

    expect(result).toEqual({ ok: false, reason: "schema_invalid" });
  });

  it("returns ok:false when the client throws rather than letting the error escape", async () => {
    const client = mockClient(vi.fn().mockRejectedValue(new Error("network exploded")));

    const result = await generateInstructions(client, input);

    expect(result).toEqual({ ok: false, reason: "api_error" });
  });

  it("returns reason: timeout for an Anthropic connection-timeout error", async () => {
    const client = mockClient(
      vi.fn().mockRejectedValue(new Anthropic.APIConnectionTimeoutError()),
    );

    const result = await generateInstructions(client, input);

    expect(result).toEqual({ ok: false, reason: "timeout" });
  });

  it("returns ok:false when the response has no text block", async () => {
    const client = mockClient(
      vi.fn().mockResolvedValue({ content: [] } as unknown as Anthropic.Message),
    );

    const result = await generateInstructions(client, input);

    expect(result).toEqual({ ok: false, reason: "invalid_response" });
  });
});
