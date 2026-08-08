import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicMessagesClient } from "./generateInstructions.js";
import { buildDishPrompt, type DishPromptInput } from "./dishPrompt.js";
import { GeneratedDishOutputSchema, type GeneratedDishOutput } from "../schema/generatedDish.js";
import {
  CuisineSchema,
  FamiliaritySchema,
  IngredientSlotRoleSchema,
  MealTypeSchema,
  PrepTimeBandSchema,
  ProteinGroupSchema,
} from "../schema/recipeTemplate.js";

// Tier 2 on-demand dish generation (issue #113). Same contract as
// generateInstructions.ts and for the same reason: this is the only module that
// calls the Anthropic API for Tier 2, stateless, single-turn, no conversation
// history, and it never throws — every failure mode collapses to
// `{ ok: false, reason }` so the route can always respond without a 5xx.
//
// Deliberately does NOT resolve ingredients, check allergies, or derive cost tier —
// that is entirely src/engine/generatedDish.ts's job, run by the caller on this
// module's raw (but schema-validated) output. This module's only responsibility is
// getting a structured dish proposal out of the model.

export type DishGenerationFailureReason = "timeout" | "api_error" | "invalid_response" | "schema_invalid";

export type GenerateDishResult =
  | { ok: true; output: GeneratedDishOutput }
  | { ok: false; reason: DishGenerationFailureReason };

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_TOKENS = 600;
// Longer than Tier 1's 8s: this is not a screen-transition call with a UI already
// waiting on it (issue #113 design — no user-facing surface in this slice). The next
// slice that adds a real trigger owns its own loading state and can tighten this.
const DEFAULT_TIMEOUT_MS = 15000;

// Same JSON Schema subset constraints as instructionsSchema.ts's STEPS_JSON_SCHEMA:
// additionalProperties: false, no length/count constraints — those are enforced
// afterward by GeneratedDishOutputSchema (zod), not expressible here.
const DISH_JSON_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    cuisine: { type: "string", enum: [...CuisineSchema.options] },
    prep_time_band: { type: "string", enum: [...PrepTimeBandSchema.options] },
    protein_group: { type: "string", enum: [...ProteinGroupSchema.options] },
    meal_types: {
      type: "array",
      items: { type: "string", enum: [...MealTypeSchema.options] },
    },
    familiarity: { type: "string", enum: [...FamiliaritySchema.options] },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        properties: {
          role: { type: "string", enum: [...IngredientSlotRoleSchema.options] },
          name: { type: "string" },
        },
        required: ["role", "name"],
        additionalProperties: false,
      },
    },
  },
  required: ["name", "cuisine", "prep_time_band", "protein_group", "meal_types", "familiarity", "ingredients"],
  additionalProperties: false,
} as const;

export interface GenerateDishOptions {
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export async function generateDish(
  client: AnthropicMessagesClient,
  input: DishPromptInput,
  options: GenerateDishOptions = {},
): Promise<GenerateDishResult> {
  let response: Anthropic.Message;
  try {
    response = await client.messages.create(
      {
        model: options.model ?? DEFAULT_MODEL,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: [{ role: "user", content: buildDishPrompt(input) }],
        output_config: { format: { type: "json_schema", schema: DISH_JSON_SCHEMA } },
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

  const result = GeneratedDishOutputSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: "schema_invalid" };
  }

  return { ok: true, output: result.data };
}
