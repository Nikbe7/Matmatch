import type { NextFunction, Request, RequestHandler, Response } from "express";
import { AuthError, type TokenVerifier } from "../../auth/verifyToken.js";
import { HttpError } from "../httpError.js";

// Every authenticated route depends on this running first and populating
// req.userId. There is no route below that reads a token itself — one adapter,
// one place tokens are verified.

declare module "express-serve-static-core" {
  interface Request {
    userId?: string;
  }
}

/**
 * Builds middleware that verifies the bearer token on every request it guards and
 * attaches the resulting user id. Any verification failure becomes a 401 with a
 * consistent body — never the underlying jose/JWKS error, which is why AuthError's
 * message is already generic ("invalid token") before it gets here.
 */
export function requireAuth(verifyToken: TokenVerifier): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const { userId } = await verifyToken(req.header("authorization"));
      req.userId = userId;
      next();
    } catch (cause) {
      if (cause instanceof AuthError) {
        next(new HttpError(401, "unauthorized", "authentication required", { cause }));
        return;
      }
      next(cause);
    }
  };
}
