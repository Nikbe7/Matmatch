import { ApiError } from "./api";
import { track, type AppErrorShownEvent } from "./analytics";

/**
 * What every request-failure catch site in the app collapses down to before it
 * touches the DOM — a server error becomes its code, a network failure that
 * never reached the server becomes "offline". Neither carries the server's raw
 * message: CLAUDE.md's non-negotiable that AI-facing numbers are never invented
 * has a UI-facing twin here — the household never sees backend developer text.
 * The code is logged via analytics at the moment of failure, since this is the
 * one place it still exists once the function returns.
 */
export type PresentedError = { kind: "offline" } | { kind: "error"; code: string };

export function presentError(err: unknown, context: AppErrorShownEvent["context"]): PresentedError {
  if (err instanceof ApiError) {
    track({ name: "app_error_shown", context, code: err.code });
    return { kind: "error", code: err.code };
  }
  return { kind: "offline" };
}

export const OFFLINE_MESSAGE = "Ingen anslutning. Anslut till internet och försök igen.";
export const GENERIC_ERROR_MESSAGE = "Något gick fel. Försök igen om en liten stund.";
