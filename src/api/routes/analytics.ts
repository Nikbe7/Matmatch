import { Router } from "express";
import { z } from "zod";
import type { TokenVerifier } from "../../auth/verifyToken.js";
import type { Sql } from "../../db/client.js";
import { recordAnalyticsEvents } from "../../db/analyticsEvents.js";
import { getHouseholdForOwner } from "../../db/households.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../httpError.js";

// POST /api/analytics/events — the ingest endpoint for web/src/analytics.ts's typed
// events (issue #91). Phase 1's success metrics (MVP_ROADMAP.md: Weekly Active
// Deciders, zero-input acceptance rate, repeat-use rate, Tier 0 vs 1/2 ratio) are
// counted from these events, so every session run without this endpoint wired is
// data that cannot be recovered later.
//
// The event vocabulary below is a mirror of web/src/analytics.ts's AnalyticsEvent
// union, not an import of it — the same reason SessionWeights mirrors RankingWeights
// in web/src/api.ts rather than importing it: this file lives on the Node side and
// web/ compiles without Node types on purpose, so the dependency can only run one
// direction. Drift is caught immediately: an event shape this file does not know
// about comes back as a 400 from the first request that sends it, same as the
// weights mirror.
//
// The vocabulary is closed deliberately: an unknown event name (a typo, a stale
// client) is refused outright rather than stored, and the whole batch is rejected
// rather than storing the events that did validate — a typo that lands as data is
// worse than an error that surfaces immediately.

const ChipIdSchema = z.enum(["cheaper", "faster", "other_cuisine", "something_else", "reset"]);

const SessionWeightsSchema = z.object({
  cost: z.number(),
  time: z.number(),
});

const ChipTapEventSchema = z
  .object({
    name: z.literal("refinement_chip_tap"),
    chip: ChipIdSchema,
    weights: SessionWeightsSchema,
    level: z.number().optional(),
    rerollDepth: z.number().int().nonnegative(),
  })
  .strict();

const SessionAbandonedEventSchema = z
  .object({
    name: z.literal("refinement_session_abandoned"),
    rerollDepth: z.number().int().nonnegative(),
  })
  .strict();

const MealCookedEventSchema = z
  .object({
    name: z.literal("meal_cooked"),
    templateId: z.string().min(1),
    rerollDepth: z.number().int().nonnegative(),
  })
  .strict();

const AnalyticsEventSchema = z.discriminatedUnion("name", [
  ChipTapEventSchema,
  SessionAbandonedEventSchema,
  MealCookedEventSchema,
]);

// Mirrors the frontend buffer cap (web/src/analyticsSink.ts) — a batch larger than
// the client ever sends is not a legitimate request.
const MAX_BATCH_SIZE = 50;

const BatchRequestSchema = z.object({
  events: z
    .array(
      z.object({
        event: AnalyticsEventSchema,
        clientTimestamp: z.string().datetime({ offset: true }),
      }),
    )
    .min(1)
    .max(MAX_BATCH_SIZE),
});

export function analyticsRouter(sql: Sql, verifyToken: TokenVerifier): Router {
  const router = Router();

  router.post("/api/analytics/events", requireAuth(verifyToken), async (req, res, next) => {
    try {
      const body = BatchRequestSchema.parse(req.body);

      const stored = await getHouseholdForOwner(sql, req.userId!);
      if (!stored) {
        throw new HttpError(
          404,
          "household_not_found",
          "no household exists for this user yet — create one first",
        );
      }

      await recordAnalyticsEvents(
        sql,
        req.userId!,
        stored.id,
        body.events.map(({ event, clientTimestamp }) => {
          const { name, ...payload } = event;
          return { name, payload, clientTimestamp: new Date(clientTimestamp) };
        }),
      );

      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
