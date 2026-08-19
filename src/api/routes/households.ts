import { Router } from "express";
import type { Sql } from "../../db/client.js";
import {
  createHousehold,
  getHouseholdForOwner,
  updateHousehold,
  updateHouseholdPreferenceWeights,
} from "../../db/households.js";
import { HouseholdSchema } from "../../schema/household.js";
import { PreferenceWeightsSchema } from "../../schema/preferenceWeights.js";
import type { TokenVerifier } from "../../auth/verifyToken.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../httpError.js";

export function householdsRouter(sql: Sql, verifyToken: TokenVerifier): Router {
  const router = Router();

  router.post("/api/households", requireAuth(verifyToken), async (req, res, next) => {
    try {
      // Validated here, not just at the database: a request body that fails
      // HouseholdSchema should never reach SQL at all, and the resulting error
      // message should be about the household shape, not a driver-level cast failure.
      const household = HouseholdSchema.parse(req.body);

      const stored = await createHousehold(sql, req.userId!, household);

      res.status(201).json(stored);
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/households", requireAuth(verifyToken), async (req, res, next) => {
    try {
      const stored = await getHouseholdForOwner(sql, req.userId!);

      if (!stored) {
        throw new HttpError(
          404,
          "household_not_found",
          "no household exists for this user yet — create one first",
        );
      }

      res.status(200).json(stored);
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/households", requireAuth(verifyToken), async (req, res, next) => {
    try {
      const household = HouseholdSchema.parse(req.body);

      // PUT never upserts: creation stays POST's job, and a caller with no household
      // yet gets the same 404 every other owner-scoped route returns for "none exists".
      const existing = await getHouseholdForOwner(sql, req.userId!);
      if (!existing) {
        throw new HttpError(
          404,
          "household_not_found",
          "no household exists for this user yet — create one first",
        );
      }

      const stored = await updateHousehold(sql, req.userId!, existing.id, household);
      if (!stored) {
        throw new HttpError(
          404,
          "household_not_found",
          "no household exists for this user yet — create one first",
        );
      }

      res.status(200).json(stored);
    } catch (error) {
      next(error);
    }
  });

  /**
   * The preference baseline (#157/#159), on its own route rather than as a field on
   * `PUT /api/households`.
   *
   * Deliberately separate, and it must stay that way: the profile PUT is a full
   * replacement with no version check (DECISION_LOG 2026-08-16), so an axis reachable
   * through it would be silently zeroed by any client that saved a member edit without
   * resending its weights. Two different actions — a drag on Tonight and a form save on
   * the profile — get two write paths so neither can clobber the other.
   *
   * All four axes required, no patch: `PreferenceWeightsSchema` rejects a partial body,
   * because "what did this household ask for" must not depend on the order requests
   * happened to arrive in. `simplicity` is sent and stored even though no slider renders
   * it — inert, not absent (see the schema's own comment).
   */
  router.put("/api/households/preferences", requireAuth(verifyToken), async (req, res, next) => {
    try {
      const weights = PreferenceWeightsSchema.parse(req.body);

      const existing = await getHouseholdForOwner(sql, req.userId!);
      if (!existing) {
        throw new HttpError(
          404,
          "household_not_found",
          "no household exists for this user yet — create one first",
        );
      }

      const stored = await updateHouseholdPreferenceWeights(
        sql,
        req.userId!,
        existing.id,
        weights,
      );
      if (!stored) {
        throw new HttpError(
          404,
          "household_not_found",
          "no household exists for this user yet — create one first",
        );
      }

      res.status(200).json(stored);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
