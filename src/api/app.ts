import express, { type Express } from "express";
import type { AnthropicMessagesClient } from "../ai/generateInstructions.js";
import type { TokenVerifier } from "../auth/verifyToken.js";
import type { Sql } from "../db/client.js";
import type { EngineData } from "../engine/data.js";
import { errorMiddleware } from "./middleware/errors.js";
import { analyticsRouter } from "./routes/analytics.js";
import { cookedRouter } from "./routes/cooked.js";
import { healthRouter } from "./routes/health.js";
import { householdsRouter } from "./routes/households.js";
import { instructionsRouter } from "./routes/instructions.js";
import { tonightRouter } from "./routes/tonight.js";
import { staticRouter } from "./static.js";

// App construction is separate from the listen call so tests can mount the app
// directly (via supertest) without binding a real port. Nothing here reads the
// environment or opens a connection — callers build the three dependencies
// (already-loaded engine data, an already-connected Sql, an already-configured
// TokenVerifier) and hand them in.

export interface AppDependencies {
  sql: Sql;
  engineData: EngineData;
  verifyToken: TokenVerifier;
  // Undefined when ANTHROPIC_API_KEY isn't configured (local dev, CI) — the
  // instructions route handles that by returning the null-instructions failure
  // path, never by refusing to start.
  anthropicClient?: AnthropicMessagesClient;
  // Absolute path to the built frontend (`web/dist`). Set only in the deployed
  // single-service configuration, where this process serves the client and the API
  // from one origin. Undefined in local development (Vite serves the client and
  // proxies `/api/*` here) and in tests, which leaves the app API-only — exactly
  // what it was before this option existed.
  webDistDir?: string;
}

export function createApp(deps: AppDependencies): Express {
  const app = express();

  app.use(express.json());

  app.use(healthRouter());
  app.use(householdsRouter(deps.sql, deps.verifyToken));
  app.use(tonightRouter(deps.sql, deps.engineData, deps.verifyToken));
  app.use(cookedRouter(deps.sql, deps.engineData, deps.verifyToken));
  app.use(instructionsRouter(deps.sql, deps.engineData, deps.verifyToken, deps.anthropicClient));
  app.use(analyticsRouter(deps.sql, deps.verifyToken));

  // After the API routers, so a real route always wins over the SPA fallback, and
  // before the error middleware, because the fallback is ordinary middleware — put
  // it after, and Express would have no handler left between it and the 4-arg error
  // handler for an unmatched path.
  if (deps.webDistDir) {
    app.use(staticRouter(deps.webDistDir));
  }

  // Registered last: Express dispatches a 4-arg handler as error middleware only
  // when it is the last thing in the chain relative to where the error was thrown.
  app.use(errorMiddleware);

  return app;
}
