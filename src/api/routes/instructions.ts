import { Router } from "express";
import { z } from "zod";
import type { AnthropicMessagesClient } from "../../ai/generateInstructions.js";
import { generateInstructions } from "../../ai/generateInstructions.js";
import type { TokenVerifier } from "../../auth/verifyToken.js";
import type { Sql } from "../../db/client.js";
import { buildSubstitutionKey, getCachedInstructions, insertCachedInstructions } from "../../db/recipeInstructions.js";
import type { EngineData } from "../../engine/data.js";
import { buildEffectiveIngredients, validateSubstitutionRefs } from "../instructionsIngredients.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../httpError.js";

// Tier 1 cooking instructions (issue #78). Never a 5xx and never blocks the
// suggestion: every AI failure mode (missing key, timeout, API error, invalid
// response) resolves to `200 { instructions: null, reason }`, so the shopping list
// screen always has something to render. Only a malformed/unknown request from the
// client (bad template id, bad substitution) is a 4xx — that's the client's mistake,
// not the AI's.

const SubstitutionRefSchema = z.object({
  slot_index: z.number().int().nonnegative(),
  substitute_ingredient_id: z.string().min(1),
});

const InstructionsRequestSchema = z.object({
  templateId: z.string().min(1),
  substitutions: z.array(SubstitutionRefSchema).default([]),
});

export interface InstructionsResponseBody {
  instructions: string[] | null;
  reason?: string;
}

export function instructionsRouter(
  sql: Sql,
  engineData: EngineData,
  verifyToken: TokenVerifier,
  anthropicClient: AnthropicMessagesClient | undefined,
): Router {
  const router = Router();

  router.post("/api/instructions", requireAuth(verifyToken), async (req, res, next) => {
    try {
      const body = InstructionsRequestSchema.parse(req.body);

      const template = engineData.templates.find((candidate) => candidate.id === body.templateId);
      if (!template) {
        throw new HttpError(404, "template_not_found", `no recipe template "${body.templateId}"`);
      }

      validateSubstitutionRefs(engineData, template, body.substitutions);

      const substitutionKey = buildSubstitutionKey(body.substitutions);

      const cached = await getCachedInstructions(sql, template.id, substitutionKey);
      if (cached) {
        res.status(200).json({ instructions: cached } satisfies InstructionsResponseBody);
        return;
      }

      if (!anthropicClient) {
        // ANTHROPIC_API_KEY not configured (e.g. local dev, CI). Distinguishable
        // reason so a missing key can never be mistaken for a working generation —
        // see the "ai_not_configured" test and DECISION_LOG 2026-08-05.
        res.status(200).json({ instructions: null, reason: "ai_not_configured" } satisfies InstructionsResponseBody);
        return;
      }

      const ingredients = buildEffectiveIngredients(engineData, template, body.substitutions);
      const generated = await generateInstructions(anthropicClient, {
        dishName: template.name,
        cuisine: template.cuisine,
        prepTimeBand: template.prep_time_band,
        ingredients,
      });

      if (!generated.ok) {
        res.status(200).json({ instructions: null, reason: generated.reason } satisfies InstructionsResponseBody);
        return;
      }

      // Cache before responding: the next identical request (this or another
      // household) should hit the cache, not regenerate. A write race is handled by
      // the table's own `on conflict do nothing` (recipeInstructions.ts), not here.
      await insertCachedInstructions(sql, template.id, substitutionKey, generated.steps);

      res.status(200).json({ instructions: generated.steps } satisfies InstructionsResponseBody);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
