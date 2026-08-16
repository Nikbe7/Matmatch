import { describe, expect, it } from "vitest";
import { authErrorMessage, GENERIC_AUTH_ERROR } from "./authErrors";

// #168: Supabase's auth errors are English and were rendered verbatim on an
// otherwise Swedish first screen. What matters here is that the common cases read
// as something a household can act on, and that nothing English can reach the
// screen through the fallback.
describe("authErrorMessage", () => {
  it("translates the common cases by code", () => {
    expect(authErrorMessage({ code: "invalid_credentials", message: "Invalid login credentials" })).toBe(
      "Fel e-postadress eller lösenord.",
    );
    expect(authErrorMessage({ code: "user_already_exists", message: "User already registered" })).toBe(
      "Det finns redan ett konto med den här e-postadressen.",
    );
    expect(authErrorMessage({ code: "email_exists", message: "Email address already in use" })).toBe(
      "Det finns redan ett konto med den här e-postadressen.",
    );
    expect(
      authErrorMessage({ code: "weak_password", message: "Password should be at least 6 characters" }),
    ).toBe("Lösenordet är för svagt. Välj minst sex tecken.");
  });

  it("falls back to the message for older responses that carry no code", () => {
    // GoTrue only started sending `code` relatively recently, and a proxy can drop
    // it — the substring match is the safety net, never the primary key.
    expect(authErrorMessage({ code: undefined, message: "Invalid login credentials" })).toBe(
      "Fel e-postadress eller lösenord.",
    );
    expect(
      authErrorMessage({ code: undefined, message: "Password should be at least 6 characters" }),
    ).toBe("Lösenordet är för svagt. Välj minst sex tecken.");
    expect(authErrorMessage({ code: undefined, message: "User already registered" })).toBe(
      "Det finns redan ett konto med den här e-postadressen.",
    );
  });

  it("matches the message case-insensitively", () => {
    expect(authErrorMessage({ code: undefined, message: "INVALID LOGIN CREDENTIALS" })).toBe(
      "Fel e-postadress eller lösenord.",
    );
  });

  it("gives a generic Swedish line rather than leaking an unrecognised English one", () => {
    // A vague Swedish message beats an English one: the latter reads as a crash
    // rather than as something the household can do anything about.
    expect(
      authErrorMessage({ code: "hook_payload_over_size_limit", message: "Payload too large" }),
    ).toBe(GENERIC_AUTH_ERROR);
    expect(authErrorMessage({ code: undefined, message: "Something exploded" })).toBe(
      GENERIC_AUTH_ERROR,
    );
    expect(authErrorMessage({ code: undefined, message: "" })).toBe(GENERIC_AUTH_ERROR);
  });

  it("never returns an empty or English string for any known code", () => {
    const codes = [
      "invalid_credentials",
      "email_not_confirmed",
      "user_already_exists",
      "email_exists",
      "weak_password",
      "email_address_invalid",
      "validation_failed",
      "over_request_rate_limit",
      "over_email_send_rate_limit",
      "signup_disabled",
      "user_banned",
    ];
    for (const code of codes) {
      const message = authErrorMessage({ code, message: "irrelevant" });
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toBe(GENERIC_AUTH_ERROR);
      // Every translated line ends as a Swedish sentence, and none of them is the
      // server's own text passed through.
      expect(message).not.toContain("irrelevant");
    }
  });
});
