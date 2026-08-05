import Anthropic from "@anthropic-ai/sdk";
import { buildInstructionsPrompt, type InstructionsPromptInput } from "./instructionsPrompt.js";
import { GeneratedInstructionsSchema } from "./instructionsSchema.js";

// The only module that calls the Anthropic API. Stateless, single-turn, no
// conversation history ever (ARCHITECTURE.md §4.2) — every call is independent, so
// there is nothing here that could leak one household's context into another's
// generation.
//
// Never throws: every failure mode (timeout, network/API error, a response with no
// parseable text, JSON that doesn't match GeneratedInstructionsSchema) collapses to
// `{ ok: false, reason }` so the route can always answer 200 with instructions: null
// rather than propagating a 5xx or an unhandled rejection.

/** The minimal surface this module needs — lets tests substitute a fake client
 * without mocking the whole SDK. */
export interface AnthropicMessagesClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: Anthropic.RequestOptions,
    ): Promise<Anthropic.Message>;
  };
}

export type InstructionsFailureReason = "timeout" | "api_error" | "invalid_response" | "schema_invalid";

export type GenerateInstructionsResult =
  | { ok: true; steps: string[] }
  | { ok: false; reason: InstructionsFailureReason };

const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_MAX_TOKENS = 400;
const DEFAULT_TIMEOUT_MS = 8000;

// additionalProperties: false and no numeric/string-length constraints, per the
// structured-outputs JSON Schema subset Claude Haiku 4.5 supports — item-count and
// per-step length are enforced afterward by GeneratedInstructionsSchema (zod), not
// expressible here.
const STEPS_JSON_SCHEMA = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["steps"],
  additionalProperties: false,
} as const;

export interface GenerateInstructionsOptions {
  model?: string;
  maxTokens?: number;
  /** Hard timeout on the AI call — this is the "user is not left waiting" cap. */
  timeoutMs?: number;
}

export async function generateInstructions(
  client: AnthropicMessagesClient,
  input: InstructionsPromptInput,
  options: GenerateInstructionsOptions = {},
): Promise<GenerateInstructionsResult> {
  let response: Anthropic.Message;
  try {
    response = await client.messages.create(
      {
        model: options.model ?? DEFAULT_MODEL,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: [{ role: "user", content: buildInstructionsPrompt(input) }],
        output_config: { format: { type: "json_schema", schema: STEPS_JSON_SCHEMA } },
      },
      { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "api_error" };
  }

  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text",
  );
  if (!textBlock) {
    return { ok: false, reason: "invalid_response" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    return { ok: false, reason: "invalid_response" };
  }

  const result = GeneratedInstructionsSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: "schema_invalid" };
  }

  return { ok: true, steps: result.data.steps };
}
