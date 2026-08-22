import type ImageKit from "@imagekit/nodejs";
import { Router } from "express";
import type { TokenVerifier } from "../../auth/verifyToken.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../httpError.js";

// Signs the short-lived params (token, expire, signature) a client-side upload needs,
// per ImageKit's standard auth pattern: the private key never leaves this process, so
// the browser can prove it holds a signature this backend minted without ever holding
// the key itself. Read-only — this route uploads nothing and touches no database row.

export interface ImagekitAuthResponseBody {
  token: string;
  expire: number;
  signature: string;
  publicKey: string;
}

export function imagekitAuthRouter(
  verifyToken: TokenVerifier,
  imagekitClient: ImageKit | undefined,
  // Never logged or returned by this route directly — only threaded into the
  // response body, which is exactly what the client-side upload() call expects
  // alongside the signed params above.
  publicKey: string | undefined,
): Router {
  const router = Router();

  router.get("/api/imagekit/auth", requireAuth(verifyToken), (_req, res) => {
    if (!imagekitClient || !publicKey) {
      throw new HttpError(503, "imagekit_not_configured", "image uploads are not configured");
    }

    const { token, expire, signature } = imagekitClient.helper.getAuthenticationParameters();

    res.status(200).json({ token, expire, signature, publicKey } satisfies ImagekitAuthResponseBody);
  });

  return router;
}
