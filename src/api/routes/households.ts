import { Router } from "express";
import type { Sql } from "../../db/client.js";
import { createHousehold } from "../../db/households.js";
import { HouseholdSchema } from "../../schema/household.js";
import type { TokenVerifier } from "../../auth/verifyToken.js";
import { requireAuth } from "../middleware/auth.js";

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

  return router;
}
