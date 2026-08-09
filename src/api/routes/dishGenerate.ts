import { Router } from "express";
import { z } from "zod";
import type { AnthropicMessagesClient } from "../../ai/generateInstructions.js";
import { generateDish } from "../../ai/generateDish.js";
import type { TokenVerifier } from "../../auth/verifyToken.js";
import type { Sql } from "../../db/client.js";
import {
  buildQueryKey,
  countGenerationAttemptsLast24h,
  getCachedGeneratedDish,
  insertGeneratedDish,
  recordGenerationAttempt,
} from "../../db/generatedDishes.js";
import { getHouseholdForOwner } from "../../db/households.js";
import { recordUnresolvedIngredient } from "../../db/ingredientReviewQueue.js";
import { passesHardDietaryFilter } from "../../engine/candidates.js";
import { mealDiners } from "../../engine/constraints.js";
import type { EngineData } from "../../engine/data.js";
import { isGeneratedDishVisibleToHousehold, resolveGeneratedDish } from "../../engine/generatedDish.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../httpError.js";
import { parseDinersFromQuery } from "../diners.js";

// Tier 2 on-demand dish generation (issue #113). Minimal trigger only — no
// user-facing surface in this slice (the search box is the next one). Same
// never-a-5xx-for-an-AI-failure contract as POST /api/instructions: every AI
// failure mode, and the daily spend ceiling, resolves to `200 { dish: null, reason }`.
// Only a malformed request is a 4xx.
//
// Global daily generation ceiling (DECISION_LOG 2026-08-05 / 2026-08-09): a solo-
// project-scale constant, not configuration — revisit with real usage data, not by
// feel, same posture as instructions.ts's DEFAULT_TIMEOUT_MS comment.
export const DEFAULT_DAILY_GENERATION_LIMIT = 200;

const DishGenerateRequestSchema = z.object({
  query: z.string().trim().min(1).max(200),
});

export interface DishGenerateResponseDish {
  name: string;
  cuisine: string;
  prep_time_band: string;
  protein_group: string;
  meal_types: string[];
  familiarity: string;
  cost_tier: string | null;
  ingredients: { role: string; name: string }[];
  // The requirement 3 contract, made explicit rather than implied: a household with
  // no declared allergies may see a dish with an unresolved ingredient, and this is
  // how the caller is told that happened — nothing else in the response implies a
  // dish "has been checked" when it hasn't been, fully.
  unverified: boolean;
}

export interface DishGenerateResponseBody {
  dish: DishGenerateResponseDish | null;
  reason?: string;
}

function catalogIngredientNames(engineData: EngineData): string[] {
  return [...engineData.ingredientsById.values()]
    .map((ingredient) => ingredient.name)
    .sort((a, b) => a.localeCompare(b, "sv"));
}

export function dishGenerateRouter(
  sql: Sql,
  engineData: EngineData,
  verifyToken: TokenVerifier,
  anthropicClient: AnthropicMessagesClient | undefined,
  // Overridable only so tests can exercise the ceiling without inserting 200 rows —
  // production callers never pass this.
  dailyGenerationLimit: number = DEFAULT_DAILY_GENERATION_LIMIT,
): Router {
  const router = Router();

  router.post("/api/dishes/generate", requireAuth(verifyToken), async (req, res, next) => {
    try {
      const body = DishGenerateRequestSchema.parse(req.body);

      const stored = await getHouseholdForOwner(sql, req.userId!);
      if (!stored) {
        throw new HttpError(
          404,
          "household_not_found",
          "no household exists for this user yet — create one first",
        );
      }

      // Derived through the same function Tonight and the guided flow use, so the
      // Tier 2 safety gate below can never apply a different constraint set from the
      // one that filtered the curated library — including which diners it is for.
      // `diners` rides on the query string even though this is a POST, so all four
      // endpoints spell the parameter the same way; no surface sends it yet (the
      // search box is a later slice), and absent means the whole household.
      const selectedDiners = parseDinersFromQuery((req.query as Record<string, unknown>).diners);
      const { constraints } = mealDiners(stored.household.members, selectedDiners);

      const queryKey = buildQueryKey(body.query);

      let output = await getCachedGeneratedDish(sql, queryKey);

      if (!output) {
        if (!anthropicClient) {
          res.status(200).json({ dish: null, reason: "ai_not_configured" } satisfies DishGenerateResponseBody);
          return;
        }

        const attemptsLast24h = await countGenerationAttemptsLast24h(sql);
        if (attemptsLast24h >= dailyGenerationLimit) {
          res.status(200).json({ dish: null, reason: "generation_limit" } satisfies DishGenerateResponseBody);
          return;
        }

        // Recorded before the call, not after: the ceiling protects spend, so a
        // timeout or API error still counts against it.
        await recordGenerationAttempt(sql);

        const generated = await generateDish(anthropicClient, {
          query: body.query,
          catalogIngredientNames: catalogIngredientNames(engineData),
        });

        if (!generated.ok) {
          res.status(200).json({ dish: null, reason: generated.reason } satisfies DishGenerateResponseBody);
          return;
        }

        output = generated.output;
        // Cache before proceeding: the next identical query (this or another
        // household) should hit the cache, not regenerate. Race handled by the
        // table's own `on conflict do nothing` (generatedDishes.ts), not here.
        await insertGeneratedDish(sql, queryKey, output);
      }

      const resolved = resolveGeneratedDish(engineData, output);

      for (const name of resolved.unresolvedNames) {
        const role = resolved.slots.find((slot) => slot.proposedName === name)?.role ?? "unknown";
        await recordUnresolvedIngredient(sql, name, role);
      }

      const visible =
        isGeneratedDishVisibleToHousehold(engineData, resolved, constraints.allergies) &&
        passesHardDietaryFilter(resolved.dietaryTags, constraints.dietary_flags);

      if (!visible) {
        res.status(200).json({ dish: null, reason: "no_safe_dish" } satisfies DishGenerateResponseBody);
        return;
      }

      res.status(200).json({
        dish: {
          name: output.name,
          cuisine: output.cuisine,
          prep_time_band: output.prep_time_band,
          protein_group: output.protein_group,
          meal_types: output.meal_types,
          familiarity: output.familiarity,
          cost_tier: resolved.costTier ?? null,
          ingredients: resolved.slots.map((slot) => ({
            role: slot.role,
            // Resolved: the catalog's own spelling. Unresolved: the model's raw
            // proposed name, best-effort — `unverified` below is what tells the
            // caller this ingredient was never checked against anything.
            name: slot.ingredientId
              ? (engineData.ingredientsById.get(slot.ingredientId)?.name ?? slot.proposedName)
              : slot.proposedName,
          })),
          unverified: resolved.hasUnverifiedContent,
        },
      } satisfies DishGenerateResponseBody);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
