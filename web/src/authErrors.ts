import type { AuthError } from "@supabase/supabase-js";

/**
 * Supabase's auth errors are English, server-authored, and were rendered straight
 * onto the sign-in screen — "Invalid login credentials" in the middle of an
 * otherwise Swedish product (#168). Translated here rather than at the call site so
 * there is exactly one place that decides what a household is told went wrong.
 *
 * Keyed on `code` first: the message text is server copy that changes between
 * GoTrue releases, the code is the stable contract. `messageFallbacks` below exists
 * only for older responses that carry no code at all — matched on a lowercase
 * substring, never on equality, for the same reason.
 *
 * Anything unrecognised becomes `GENERIC_AUTH_ERROR`. That is deliberate: an
 * untranslated English string leaking through would be worse than a vague Swedish
 * one, because it reads as a crash rather than as something the household can act on.
 */
const CODE_MESSAGES: Record<string, string> = {
  invalid_credentials: "Fel e-postadress eller lösenord.",
  email_not_confirmed: "Bekräfta din e-postadress innan du loggar in.",
  user_already_exists: "Det finns redan ett konto med den här e-postadressen.",
  email_exists: "Det finns redan ett konto med den här e-postadressen.",
  weak_password: "Lösenordet är för svagt. Välj minst sex tecken.",
  email_address_invalid: "E-postadressen ser inte ut att stämma.",
  validation_failed: "Kontrollera e-postadressen och lösenordet.",
  over_request_rate_limit: "För många försök. Vänta en stund och försök igen.",
  over_email_send_rate_limit: "För många försök. Vänta en stund och försök igen.",
  signup_disabled: "Det går inte att skapa konto just nu.",
  user_banned: "Kontot är spärrat.",
};

/** Pre-`code` GoTrue responses, and anything proxied without one. */
const MESSAGE_FALLBACKS: readonly (readonly [string, string])[] = [
  ["invalid login credentials", CODE_MESSAGES.invalid_credentials!],
  ["email not confirmed", CODE_MESSAGES.email_not_confirmed!],
  ["already registered", CODE_MESSAGES.user_already_exists!],
  ["already been registered", CODE_MESSAGES.user_already_exists!],
  ["password should be at least", CODE_MESSAGES.weak_password!],
  ["unable to validate email address", CODE_MESSAGES.email_address_invalid!],
  ["rate limit", CODE_MESSAGES.over_request_rate_limit!],
];

export const GENERIC_AUTH_ERROR = "Det gick inte just nu. Försök igen.";

export function authErrorMessage(error: Pick<AuthError, "code" | "message">): string {
  const byCode = error.code ? CODE_MESSAGES[error.code] : undefined;
  if (byCode) return byCode;

  const message = (error.message ?? "").toLowerCase();
  const byMessage = MESSAGE_FALLBACKS.find(([needle]) => message.includes(needle));
  return byMessage ? byMessage[1] : GENERIC_AUTH_ERROR;
}
