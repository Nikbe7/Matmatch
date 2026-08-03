import { Router } from "express";

// Unauthenticated, no DB call — what the host's health check hits. If this route
// ever needs a dependency, it stops being a health check and becomes a readiness
// check; keep those separate rather than growing this one.
export function healthRouter(): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  return router;
}
