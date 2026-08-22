// ImageKit config + the upload authenticator, kept separate from api.ts because this
// is the one place the frontend talks to a third-party media host rather than our own
// backend. Unlike supabaseClient.ts, these are optional: nothing in the app calls this
// module yet (issue: add when a screen actually uses it), so it must not throw at
// import time for every household that hasn't set the env vars — only when a caller
// that actually needs ImageKit runs without it configured.

export const imagekitUrlEndpoint = import.meta.env.VITE_IMAGEKIT_URL_ENDPOINT;
export const imagekitPublicKey = import.meta.env.VITE_IMAGEKIT_PUBLIC_KEY;

class ImagekitNotConfiguredError extends Error {
  constructor() {
    super("VITE_IMAGEKIT_URL_ENDPOINT and VITE_IMAGEKIT_PUBLIC_KEY must be set — see web/.env.example");
    this.name = "ImagekitNotConfiguredError";
  }
}

export function requireImagekitConfig(): { urlEndpoint: string; publicKey: string } {
  if (!imagekitUrlEndpoint || !imagekitPublicKey) throw new ImagekitNotConfiguredError();
  return { urlEndpoint: imagekitUrlEndpoint, publicKey: imagekitPublicKey };
}

/**
 * The `authenticator` the `@imagekit/react` `upload()` call needs: fetches a
 * freshly-signed token/expire/signature from the backend (`GET /api/imagekit/auth`,
 * `src/api/routes/imagekitAuth.ts`) using the same bearer-token pattern as every other
 * call in api.ts. The private key never reaches the browser — this is the only path a
 * client-side upload has to prove it's allowed to write to the media library.
 */
export function imagekitAuthenticator(accessToken: string) {
  return async () => {
    const response = await fetch("/api/imagekit/auth", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const body: unknown = await response.json();

    if (!response.ok) {
      const { error } = body as { error: { code: string; message: string } };
      throw new Error(`imagekit auth failed: ${error.code} — ${error.message}`);
    }

    return body as { token: string; expire: number; signature: string; publicKey: string };
  };
}
