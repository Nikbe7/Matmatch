import { Router } from "express";
import { z } from "zod";
import type { AnthropicMessagesClient } from "../../ai/generateInstructions.js";
import { generateInstructions } from "../../ai/generateInstructions.js";
import type { TokenVerifier } from "../../auth/verifyToken.js";
import type { Sql } from "../../db/client.js";
import { buildSubstitutionKey, getCachedInstructions, insertCachedInstructions } from "../../db/recipeInstructions.js";
import type { EngineData } from "../../engine/data.js";
import {
  buildEffectiveIngredients,
  effectiveIngredientIds,
  validateSubstitutionRefs,
} from "../instructionsIngredients.js";
import {
  buildIngredientLexicon,
  validateGeneratedInstructions,
  type IngredientLexicon,
} from "../../ai/instructionsValidation.js";
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

  // Built once, on the first request that needs it — not at construction. The
  // catalog is fixed for the process's lifetime so one build is enough, but
  // `createApp` is also used to mount a health check with no engine data at all
  // (app.test.ts), and a router that reads the catalog just to be constructed would
  // make /health depend on it.
  let lexicon: IngredientLexicon | undefined;
  function ingredientLexicon(): IngredientLexicon {
    lexicon ??= buildIngredientLexicon(
      engineData.ingredientsById.values(),
      engineData.allergenMappingByIngredientId,
    );
    return lexicon;
  }

  router.post("/api/instructions", requireAuth(verifyToken), async (req, res, next) => {
    try {
      const body = InstructionsRequestSchema.parse(req.body);

      const template = engineData.templates.find((candidate) => candidate.id === body.templateId);
      if (!template) {
        throw new HttpError(404, "template_not_found", `no recipe template "${body.templateId}"`);
      }

      validateSubstitutionRefs(engineData, template, body.substitutions);

      const substitutionKey = buildSubstitutionKey(body.substitutions);

      const allowedIngredientIds = effectiveIngredientIds(template, body.substitutions);

      // Cache hits are validated too, not trusted (#154). The table predates this
      // validator (migration 20260805000000) and its key carries no validator
      // version, so rows written before #154 — or by a future code path that forgets
      // the gate — would otherwise be served unscanned forever. A rejected row falls
      // through to regeneration and is overwritten below.
      const cached = await getCachedInstructions(sql, template.id, substitutionKey);
      if (cached) {
        const cachedValidation = validateGeneratedInstructions(
          ingredientLexicon(),
          cached,
          allowedIngredientIds,
        );
        if (cachedValidation.ok) {
          res.status(200).json({ instructions: cached } satisfies InstructionsResponseBody);
          return;
        }
        console.warn(
          `[instructions] discarding cached generation for template "${template.id}": ` +
            `${cachedValidation.rejection.kind} — ${cachedValidation.rejection.mentions.join(", ")}`,
        );
      }

      if (!anthropicClient) {
        // ANTHROPIC_API_KEY not configured (e.g. local dev, CI). Distinguishable
        // reason so a missing key can never be mistaken for a working generation —
        // see the "ai_not_configured" test and DECISION_LOG 2026-08-05.
        res.status(200).json({ instructions: null, reason: "ai_not_configured" } satisfies InstructionsResponseBody);
        return;
      }

      const ingredients = buildEffectiveIngredients(engineData, template, body.substitutions);
      const promptInput = {
        dishName: template.name,
        cuisine: template.cuisine,
        prepTimeBand: template.prep_time_band,
        ingredients,
      };

      // One regeneration on a rejected result, then give up (#154). Not a loop: a
      // model that broke the ingredient rule twice on the same minimal prompt is not
      // going to be talked round by a third identical attempt, and the household is
      // waiting. Rejected content is never repaired and never cached — see
      // instructionsValidation.ts.
      let steps: string[] | undefined;
      let lastFailure: string | undefined;

      for (let attempt = 0; attempt < 2 && steps === undefined; attempt++) {
        const generated = await generateInstructions(anthropicClient, promptInput);
        if (!generated.ok) {
          lastFailure = generated.reason;
          // A transport failure is not something a retry with identical input fixes
          // inside the household's patience budget — the retry exists for rejected
          // *content*, so stop here and let the screen offer "Försök igen".
          break;
        }

        const validation = validateGeneratedInstructions(
          ingredientLexicon(),
          generated.steps,
          allowedIngredientIds,
        );
        if (validation.ok) {
          steps = generated.steps;
          break;
        }

        lastFailure = "validation_failed";
        console.warn(
          `[instructions] rejected generation for template "${template.id}" (attempt ${attempt + 1}): ` +
            `${validation.rejection.kind} — ${validation.rejection.mentions.join(", ")}`,
        );
      }

      if (steps === undefined) {
        res.status(200).json({ instructions: null, reason: lastFailure } satisfies InstructionsResponseBody);
        return;
      }

      // Cache before responding: the next identical request (this or another
      // household) should hit the cache, not regenerate. Reached only for a result
      // that passed validation, so the cache never holds content that would be
      // rejected if it were generated again — and the write replaces any row the
      // check above discarded.
      await insertCachedInstructions(sql, template.id, substitutionKey, steps);

      res.status(200).json({ instructions: steps } satisfies InstructionsResponseBody);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
