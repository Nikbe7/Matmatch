import type { Session } from "@supabase/supabase-js";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALLERGIES } from "../../src/schema/vocabulary";
import type { CostTier } from "../../src/schema/ingredient";
import { setAnalyticsSink, type AnalyticsEvent } from "./analytics";
import { saveShoppingList, SHOPPING_LIST_VERSION } from "./shoppingListStorage";
import { saveCookRecord, substitutionKey } from "./instructionsStorage";
import { WEIGHT_LEVELS } from "./refinement";

// Covers the signed-out state (login form, never reaches the network) and the
// household gate: no-household → onboarding, submit → Tonight, API error →
// message + form retained, a null-result Tonight response never bounces an
// existing household back through onboarding, and the locked allergy vocabulary
// renders as exactly the chips shown. Smoke-level per CLAUDE.md — not a full
// auth-flow or full-form-validation suite.

const fakeSession = {
  access_token: "token-123",
  user: { email: "chef@example.com" },
} as unknown as Session;

const sessionHolder: { current: Session | null } = { current: null };

const signInWithPassword = vi.fn(async (_credentials: { email: string; password: string }) => ({
  data: { session: fakeSession },
  error: null as { code?: string; message: string } | null,
}));
const signUp = vi.fn(async (_credentials: { email: string; password: string }) => ({
  data: { session: fakeSession as Session | null },
  error: null as { code?: string; message: string } | null,
}));

vi.mock("./supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: sessionHolder.current } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: () => Promise.resolve({ error: null }),
      signInWithPassword: (credentials: { email: string; password: string }) =>
        signInWithPassword(credentials),
      signUp: (credentials: { email: string; password: string }) => signUp(credentials),
    },
  },
}));

// #137: Gate installs the analytics sink once per session, above the routed
// screens, specifically so switching tabs never tears it down mid-buffer — see
// the "App — bottom navigation" describe block below for the test.
const analyticsSinkHandle = { stop: vi.fn() };
const createHttpAnalyticsSinkSpy = vi.fn((_accessToken: string) => ({
  sink: () => {},
  flush: () => {},
  stop: analyticsSinkHandle.stop,
}));
vi.mock("./analyticsSink", () => ({
  createHttpAnalyticsSink: (accessToken: string) => createHttpAnalyticsSinkSpy(accessToken),
}));

const { default: App } = await import("./App");
const { ALLERGY_LABELS, costTierMeter, costTierLabel } = await import("./App");

/** A member block, addressed the way the household sees it: by that member's label. */
function memberCard(label: string): HTMLElement {
  return screen.getByRole("heading", { name: label }).closest(".member-card") as HTMLElement;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const householdNotFound = jsonResponse(404, {
  error: { code: "household_not_found", message: "no household exists for this user yet" },
});

const suggestionBody = {
  result: {
    template: { id: "kycklinggryta", name: "Kycklinggryta", blurb: "Testblurb för kycklinggryta.", cost_tier: "mid", prep_time_band: "20-40min", cuisine: "swedish_nordic" },
    ingredients: [
      { role: "protein", name: "Kyckling", slotIndex: 0, ingredientId: "kyckling", substituted: false, allergens: [], quantity: { kind: "amount", amount: 400, unit: "g" } },
      { role: "aromatic", name: "Rödlök", slotIndex: 1, ingredientId: "rodlok", substituted: true, allergens: [], quantity: { kind: "amount", amount: 400, unit: "g" } },
    ],
    substitutions: [],
    score: 0.5,
    cookedToday: false,
  },
  portions: 2,
};

function suggestionBodyForTier(tier: CostTier) {
  return {
    result: {
      template: { id: "kycklinggryta", name: "Kycklinggryta", blurb: "Testblurb för kycklinggryta.", cost_tier: tier, prep_time_band: "20-40min", cuisine: "swedish_nordic" },
      ingredients: [{ role: "protein", name: "Kyckling", slotIndex: 0, ingredientId: "kyckling", substituted: false, allergens: [], quantity: { kind: "amount", amount: 400, unit: "g" } }],
      substitutions: [],
      score: 0.5,
      cookedToday: false,
    },
    portions: 2,
  };
}

beforeEach(() => {
  sessionHolder.current = null;
  localStorage.clear();
  // #137: App now renders a real router against the jsdom window, whose
  // location/history persist across tests in the same file unless reset — a
  // previous test's navigate("/lista") would otherwise leak into the next
  // test's fresh render.
  window.history.replaceState(null, "", "/");
  createHttpAnalyticsSinkSpy.mockClear();
  analyticsSinkHandle.stop.mockClear();
  signInWithPassword.mockClear();
  signInWithPassword.mockResolvedValue({ data: { session: fakeSession }, error: null });
  signUp.mockClear();
  signUp.mockResolvedValue({ data: { session: fakeSession }, error: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// #168: the first screen anyone sees. One form with a mode switch, one primary
// action, Swedish throughout — including the auth errors, which used to render
// Supabase's English text verbatim.
describe("App — the sign-in screen (#168)", () => {
  async function renderSignedOut() {
    render(<App />);
    await screen.findByRole("heading", { name: "Vad ska ni äta ikväll?" });
  }

  it("renders in Swedish, never reaches the network, and offers exactly one primary action", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await renderSignedOut();

    expect(screen.getByRole("textbox", { name: "E-post" })).toBeTruthy();
    expect(screen.getByLabelText("Lösenord")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Logga in" })).toBeTruthy();

    // The requirement, asserted structurally rather than by counting labels: the
    // old screen's two equal buttons made the household decide whether they were
    // new before they were allowed to do anything.
    expect(document.querySelectorAll(".btn-primary")).toHaveLength(1);
    expect(document.querySelectorAll(".btn-secondary")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signs in with the entered credentials", async () => {
    const user = userEvent.setup();
    await renderSignedOut();

    await user.type(screen.getByRole("textbox", { name: "E-post" }), "chef@example.com");
    await user.type(screen.getByLabelText("Lösenord"), "hemligt1");
    await user.click(screen.getByRole("button", { name: "Logga in" }));

    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "chef@example.com",
      password: "hemligt1",
    });
    expect(signUp).not.toHaveBeenCalled();
  });

  it("switches the same form to sign-up, changing the primary action rather than adding one", async () => {
    const user = userEvent.setup();
    await renderSignedOut();

    await user.click(screen.getByRole("button", { name: "Ny här? Skapa konto" }));

    expect(screen.getByRole("button", { name: "Skapa konto" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Logga in" })).toBeNull();
    expect(document.querySelectorAll(".btn-primary")).toHaveLength(1);

    await user.type(screen.getByRole("textbox", { name: "E-post" }), "ny@example.com");
    await user.type(screen.getByLabelText("Lösenord"), "hemligt1");
    await user.click(screen.getByRole("button", { name: "Skapa konto" }));

    expect(signUp).toHaveBeenCalledWith({ email: "ny@example.com", password: "hemligt1" });
    expect(signInWithPassword).not.toHaveBeenCalled();

    // And back again, on the same form.
    await user.click(screen.getByRole("button", { name: "Har du redan ett konto? Logga in" }));
    expect(screen.getByRole("button", { name: "Logga in" })).toBeTruthy();
  });

  it("translates a failed sign-in instead of leaking Supabase's English", async () => {
    const user = userEvent.setup();
    signInWithPassword.mockResolvedValue({
      data: { session: null as unknown as Session },
      error: { code: "invalid_credentials", message: "Invalid login credentials" },
    });
    await renderSignedOut();

    await user.type(screen.getByRole("textbox", { name: "E-post" }), "chef@example.com");
    await user.type(screen.getByLabelText("Lösenord"), "fellosen");
    await user.click(screen.getByRole("button", { name: "Logga in" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Fel e-postadress eller lösenord.");
    expect(alert.textContent).not.toContain("Invalid");
  });

  it("says something visible when sign-up succeeds without a session", async () => {
    // Email confirmation is on: no session arrives, `onAuthStateChange` never
    // fires, and without this line the primary action would visibly do nothing.
    const user = userEvent.setup();
    signUp.mockResolvedValue({ data: { session: null }, error: null });
    await renderSignedOut();

    await user.click(screen.getByRole("button", { name: "Ny här? Skapa konto" }));
    await user.type(screen.getByRole("textbox", { name: "E-post" }), "ny@example.com");
    await user.type(screen.getByLabelText("Lösenord"), "hemligt1");
    await user.click(screen.getByRole("button", { name: "Skapa konto" }));

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain("Kontot är skapat");
  });

  it("clears a message from the mode that produced it when the mode changes", async () => {
    const user = userEvent.setup();
    signInWithPassword.mockResolvedValue({
      data: { session: null as unknown as Session },
      error: { code: "invalid_credentials", message: "Invalid login credentials" },
    });
    await renderSignedOut();

    await user.type(screen.getByRole("textbox", { name: "E-post" }), "chef@example.com");
    await user.type(screen.getByLabelText("Lösenord"), "fellosen");
    await user.click(screen.getByRole("button", { name: "Logga in" }));
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: "Ny här? Skapa konto" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("leaves no English anywhere on the screen, in either mode", async () => {
    const user = userEvent.setup();
    await renderSignedOut();

    const card = document.querySelector(".auth-card") as HTMLElement;
    const forbidden = ["Sign in", "Sign up", "Email", "Password", "Loading"];
    for (const word of forbidden) expect(card.textContent).not.toContain(word);

    await user.click(screen.getByRole("button", { name: "Ny här? Skapa konto" }));
    for (const word of forbidden) expect(card.textContent).not.toContain(word);
  });
});

// #168: onboarding asks who lives here, then one mandatory allergy question.
// Dietary preferences are gone from this screen entirely — they are ranking
// influence, not safety, and are edited on the profile.
describe("App — household gate", () => {
  async function renderOnboarding() {
    render(<App />);
    await screen.findByRole("heading", { name: "Vilka bor här?" });
  }

  /** Answers the allergy question, which is what unlocks the primary action. */
  async function answerAllergies(user: ReturnType<typeof userEvent.setup>, answer: "Ja" | "Nej") {
    await user.click(screen.getByRole("radio", { name: answer }));
  }

  const submit = () => screen.getByRole("button", { name: "Visa kvällens middag" });

  it("renders onboarding when signed in with no household", async () => {
    sessionHolder.current = fakeSession;
    const fetchMock = vi.fn().mockResolvedValue(householdNotFound);
    vi.stubGlobal("fetch", fetchMock);

    await renderOnboarding();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks for who lives here and nothing else — no preference chips, no allergy chips yet", async () => {
    sessionHolder.current = fakeSession;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(householdNotFound));

    await renderOnboarding();

    const card = memberCard("Vuxen 1");
    expect(within(card).getByLabelText("Namn")).toBeTruthy();
    expect(within(card).getByLabelText("Typ")).toBeTruthy();
    expect(within(card).getByLabelText("Portionsstorlek")).toBeTruthy();
    // Dietary preferences left onboarding entirely, and the allergy chips are
    // behind the question below — the member row carries neither.
    expect(card.querySelector("fieldset")).toBeNull();
    expect(screen.queryByRole("button", { name: "Vegetariskt" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Jordnötter" })).toBeNull();
  });

  it("keeps the primary action disabled until the allergy question is answered, either way", async () => {
    // The reason the question has no preselected answer (DECISION_LOG 2026-08-16):
    // a checked "Nej" would make a household that answered no indistinguishable
    // from one that never saw the question, and the app treats both as
    // allergy-free. Both answers unlock; neither is assumed.
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(householdNotFound));

    await renderOnboarding();

    expect(screen.getByRole("radio", { name: "Nej" }).hasAttribute("checked")).toBe(false);
    expect((screen.getByRole("radio", { name: "Nej" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("radio", { name: "Ja" }) as HTMLInputElement).checked).toBe(false);
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Svara på frågan om allergier först.")).toBeTruthy();

    await answerAllergies(user, "Nej");
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText("Svara på frågan om allergier först.")).toBeNull();

    // "Ja" unlocks too, once it names an allergy — see the half-answer test below.
    await answerAllergies(user, "Ja");
    await user.click(screen.getByRole("button", { name: "Jordnötter" }));
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not accept a half-answered yes — a declared allergy must name itself", async () => {
    // "Ja" with nothing picked produces a payload identical to "Nej": the household
    // would be stored as allergy-free and its first suggestion filtered against
    // nothing. Same rule as the question itself — no assuming a safety answer.
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(householdNotFound));

    await renderOnboarding();
    await answerAllergies(user, "Ja");

    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Välj vilken allergi det gäller, eller svara Nej.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Jordnötter" }));
    expect((submit() as HTMLButtonElement).disabled).toBe(false);

    // Deselecting the only allergy puts the block back — the household is once
    // again claiming an allergy it has not named.
    await user.click(screen.getByRole("button", { name: "Jordnötter" }));
    expect((submit() as HTMLButtonElement).disabled).toBe(true);

    // And "Nej" is always a way out of it.
    await answerAllergies(user, "Nej");
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
  });

  it("falls back to the derived label when a name is cleared, rather than showing a nameless allergy block", async () => {
    // An empty label is worst exactly here: several members stacked, an allergy
    // block each, and the block whose owner has no visible name is where an
    // allergy gets attached to the wrong person.
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(householdNotFound));

    await renderOnboarding();
    const nameField = within(memberCard("Vuxen 1")).getByLabelText("Namn");
    await user.type(nameField, "Ella");
    await user.clear(nameField);

    expect(screen.getByRole("heading", { name: "Vuxen 1" })).toBeTruthy();

    await answerAllergies(user, "Ja");
    const legend = document.querySelector("fieldset.allergy-group legend")!;
    expect(legend.textContent).toContain("Vuxen 1");
  });

  it("creates a valid household with empty allergy lists when the answer is no", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(householdNotFound)
      .mockResolvedValueOnce(jsonResponse(201, { id: "h1", members: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { result: null, reason: "no_safe_templates" }));
    vi.stubGlobal("fetch", fetchMock);

    await renderOnboarding();
    await answerAllergies(user, "Nej");
    await user.click(submit());

    await screen.findByRole("heading", { name: "Ikväll" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/households");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST" });

    // Explicitly empty, never omitted: an unset safety value must not be
    // mistakable for a declared-empty one (HouseholdMemberSchema).
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.members).toHaveLength(1);
    expect(body.members[0].allergies).toEqual([]);
    expect(body.members[0].dietary_flags).toEqual([]);
    expect("allergies" in body.members[0]).toBe(true);
    expect("dietary_flags" in body.members[0]).toBe(true);
  });

  it("reveals the allergy picker per person on yes, and saves exactly the picked ones to the right person", async () => {
    // The behaviour #115 exists for: after this, "whose allergy is it" survives the
    // round trip, which is what #112 needs to narrow constraints to tonight's diners.
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(householdNotFound)
      .mockResolvedValueOnce(jsonResponse(201, { id: "h1", members: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { result: null, reason: "no_safe_templates" }));
    vi.stubGlobal("fetch", fetchMock);

    await renderOnboarding();
    await user.click(screen.getByRole("button", { name: "+ Lägg till medlem" }));
    await answerAllergies(user, "Ja");

    // One block per person, each naming whose allergies it holds.
    const blocks = Array.from(document.querySelectorAll("fieldset.allergy-group"));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.querySelector("legend")!.textContent).toContain("Vuxen 1");
    expect(blocks[1]!.querySelector("legend")!.textContent).toContain("Vuxen 2");

    await user.click(within(blocks[0] as HTMLElement).getByRole("button", { name: "Jordnötter" }));
    await user.click(within(blocks[0] as HTMLElement).getByRole("button", { name: "Fisk" }));
    await user.click(submit());
    await screen.findByRole("heading", { name: "Ikväll" });

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.members).toHaveLength(2);
    expect(body.members[0]).toMatchObject({ allergies: ["peanuts", "fish"], dietary_flags: [] });
    expect(body.members[1]).toMatchObject({ allergies: [], dietary_flags: [] });
    // The household itself no longer carries either field.
    expect(body.allergies).toBeUndefined();
    expect(body.dietary_flags).toBeUndefined();
  });

  it("saves the household only after the allergy answer, never before it", async () => {
    // The failure mode this change could introduce: a first suggestion shown for a
    // household whose declared allergy had not been recorded yet. Asserted on the
    // call order — the Tonight request that produces that suggestion must come
    // after the POST that carries the allergy.
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(householdNotFound)
      .mockResolvedValueOnce(jsonResponse(201, { id: "h1", members: [] }))
      .mockResolvedValueOnce(jsonResponse(200, suggestionBody));
    vi.stubGlobal("fetch", fetchMock);

    await renderOnboarding();
    await answerAllergies(user, "Ja");
    await user.click(
      within(document.querySelector("fieldset.allergy-group") as HTMLElement).getByRole("button", {
        name: "Jordnötter",
      }),
    );

    // Nothing has been written yet, and no suggestion has been requested.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(submit());
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    const [gateCall, postCall, tonightCall] = fetchMock.mock.calls;
    expect(gateCall[0]).toBe("/api/tonight");
    expect(postCall[0]).toBe("/api/households");
    expect(JSON.parse(postCall[1].body).members[0].allergies).toEqual(["peanuts"]);
    expect(tonightCall[0]).toBe("/api/tonight");
  });

  it("clears picked allergies when the answer changes back to no", async () => {
    // What is shown and what is stored have to be the same thing: a hidden
    // allergy that is nonetheless saved is the worse failure mode of the two.
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(householdNotFound)
      .mockResolvedValueOnce(jsonResponse(201, { id: "h1", members: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { result: null, reason: "no_safe_templates" }));
    vi.stubGlobal("fetch", fetchMock);

    await renderOnboarding();
    await answerAllergies(user, "Ja");
    await user.click(screen.getByRole("button", { name: "Jordnötter" }));
    await answerAllergies(user, "Nej");

    expect(document.querySelector("fieldset.allergy-group")).toBeNull();

    await user.click(submit());
    await screen.findByRole("heading", { name: "Ikväll" });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).members[0].allergies).toEqual([]);
  });

  it("renders exactly the locked allergy vocabulary as chips, per member", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(householdNotFound));

    await renderOnboarding();
    await answerAllergies(user, "Ja");

    const block = document.querySelector("fieldset.allergy-group")!;
    const chipLabels = Array.from(block.querySelectorAll("button")).map(
      (button) => button.textContent,
    );

    expect(chipLabels).toEqual(ALLERGIES.map((allergy) => ALLERGY_LABELS[allergy]));
  });

  it("marks the allergy block as a safety constraint by more than colour", async () => {
    // #101/UX_FLOW §6, carried over to the "ja" branch: the block keeps the border,
    // the "⚠" glyph and its own legend text, all in the markup rather than only in
    // the stylesheet, so it is tellable from a preference group without colour.
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(householdNotFound));

    await renderOnboarding();
    await answerAllergies(user, "Ja");

    const block = document.querySelector("fieldset.allergy-group") as HTMLFieldSetElement;
    expect(block.tagName).toBe("FIELDSET");
    expect(block.className).toContain("allergy-group");
    const legend = block.querySelector("legend")!;
    expect(legend.textContent).toContain("Allergier");
    expect(legend.textContent).toContain("⚠");
  });

  it("keeps the form filled and shows a friendly message, never the server's raw text, on API error", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(householdNotFound)
      .mockResolvedValueOnce(
        jsonResponse(400, {
          error: { code: "invalid_request", message: "members must contain at least 1 element(s)" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await renderOnboarding();

    await user.click(screen.getByRole("button", { name: "+ Lägg till medlem" }));
    expect(screen.getAllByText("Typ")).toHaveLength(2);

    await answerAllergies(user, "Nej");
    await user.click(submit());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Något gick fel. Försök igen om en liten stund.");
    expect(alert.textContent).not.toContain("members must contain");
    expect(screen.getAllByText("Typ")).toHaveLength(2);
  });

  it("omits a blank name rather than sending an empty string", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(householdNotFound)
      .mockResolvedValueOnce(jsonResponse(201, { id: "h1", members: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { result: null, reason: "no_safe_templates" }));
    vi.stubGlobal("fetch", fetchMock);

    await renderOnboarding();
    await answerAllergies(user, "Nej");
    await user.click(submit());
    await screen.findByRole("heading", { name: "Ikväll" });

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect("name" in body.members[0]).toBe(false);
  });

  it("labels unnamed members by type and ordinal, and swaps in a name once given", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(householdNotFound));

    await renderOnboarding();

    expect(screen.getByRole("heading", { name: "Vuxen 1" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "+ Lägg till medlem" }));
    expect(screen.getByRole("heading", { name: "Vuxen 2" })).toBeTruthy();

    // Switching a member to "Barn" renumbers within the new type, not across the list.
    const typeSelects = screen.getAllByLabelText("Typ");
    await user.selectOptions(typeSelects[1]!, "child");
    expect(screen.getByRole("heading", { name: "Barn 1" })).toBeTruthy();

    await user.type(within(memberCard("Barn 1")).getByLabelText("Namn"), "Ella");
    expect(screen.getByRole("heading", { name: "Ella" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Barn 1" })).toBeNull();

    // The hint keeps describing what *clearing* the field would give, rather than
    // reading back the name the member already has.
    expect(within(memberCard("Ella")).getByText(/Lämna tomt/).textContent).toContain("Barn 1");
  });

  it("keeps a household with no safe result in the Tonight no-result state, not onboarding", async () => {
    sessionHolder.current = fakeSession;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { result: null, reason: "no_safe_templates" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await screen.findByRole("heading", { name: "Ikväll" });
    expect(
      screen.getByRole("heading", { name: "Inget i kvällens meny passar hushållet" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Vilka bor här?" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows the loading skeleton, not an error, for the transient 'household_updated' reason", async () => {
    // Set client-side by Gate's own handleHouseholdUpdated while its background
    // refetch is in flight (App.tsx) — a loading beat, not a state to explain.
    sessionHolder.current = fakeSession;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { result: null, reason: "household_updated" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await screen.findByRole("heading", { name: "Ikväll" });
    expect(document.querySelector(".skeleton-card")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows an unrecognised no-result reason as a generic error, never the raw reason string as body text", async () => {
    sessionHolder.current = fakeSession;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { result: null, reason: "some_future_reason" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await screen.findByRole("heading", { name: "Ikväll" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Något gick fel. Försök igen om en liten stund.");
    // The reason code only ever appears in the quiet debugging reference below the
    // action, never as the headline or the message itself.
    expect(
      screen.getByRole("heading", { name: "Kunde inte visa kvällens förslag" }),
    ).toBeTruthy();
    expect(document.querySelector("pre")).toBeNull();
  });

  it("shows a full-screen error, never the server's raw code or message, when the initial fetch fails", async () => {
    sessionHolder.current = fakeSession;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(500, { error: { code: "internal_error", message: "something went wrong" } }),
      ),
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Det gick inte att hämta kvällens förslag" }),
    ).toBeTruthy();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Något gick fel. Försök igen om en liten stund.");
    expect(screen.queryByText(/something went wrong/)).toBeNull();
    expect(document.querySelector("pre")).toBeNull();
    // The code is still visible, but only as the quiet reference line, not as
    // the headline or the body message.
    expect(document.body.textContent).toContain("internal_error");
    expect(screen.getByRole("button", { name: "Försök igen" })).toBeTruthy();
  });
});

describe("costTierMeter / costTierLabel", () => {
  const expected: Record<CostTier, { meter: string; label: string }> = {
    budget: { meter: "●○○", label: "Billig" },
    mid: { meter: "●●○", label: "Mellan" },
    premium: { meter: "●●●", label: "Dyr" },
  };

  for (const [tier, { meter, label }] of Object.entries(expected) as [CostTier, { meter: string; label: string }][]) {
    it(`maps "${tier}" to its dot meter and Swedish label`, () => {
      expect(costTierMeter(tier)).toBe(meter);
      expect(costTierLabel(tier)).toBe(label);
    });
  }
});

describe("App — Tonight suggestion card", () => {
  it("renders the dish name, cost tier meter and prep time — and no ingredient list", async () => {
    sessionHolder.current = fakeSession;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, suggestionBody)));

    const { container } = render(<App />);

    await screen.findByRole("heading", { name: "Kycklinggryta" });
    expect(screen.getByText(/20–40 min/)).toBeTruthy();
    expect(screen.getByText("Testblurb för kycklinggryta.")).toBeTruthy();

    // #183: what is *in* the dish is the shopping list's and the cook screen's job,
    // where it comes with amounts and allergen markings this screen never had. The
    // role taxonomy in particular must not appear — it was app vocabulary leaking
    // into the one screen that is supposed to read like an answer, not a record.
    for (const prefix of ["Protein:", "Mejeri:", "Stärkelse:", "Grönsak:", "Arom:"]) {
      expect(container.textContent).not.toContain(prefix);
    }
    expect(container.textContent).not.toContain("(ersättning)");
    expect(container.querySelector(".suggestion__ingredients")).toBeNull();

    // The raw "mid" enum value must never leak into rendered text — only the dot
    // meter and its Swedish accessible name should appear.
    expect(container.textContent).not.toMatch(/\bmid\b/);
    expect(container.textContent).toContain("●●○");

    // A role-based query, not an attribute check: jsdom doesn't enforce the rule
    // that aria-label is ignored on a generic-role element, so a plain
    // `container.querySelector('[aria-label="Mellan"]')` would pass even if the
    // wrapper had no naming role at all. getByRole computes the accessible name
    // the way a real screen reader would and fails if role="img" is missing.
    const meter = screen.getByRole("img", { name: "Mellan" });
    const dots = meter.querySelector('[aria-hidden="true"]');
    expect(dots).not.toBeNull();
    expect(dots!.textContent).toBe("●●○");
  });

  it("shows the one-line reason when the server sends codes, phrased as a sentence with no numbers", async () => {
    sessionHolder.current = fakeSession;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          ...suggestionBody,
          result: { ...suggestionBody.result, reasonCodes: ["in_season", "not_recently_cooked"] },
        }),
      ),
    );

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    const reason = screen.getByText(/^Valt för att/);
    expect(reason.textContent).toContain(" och ");
    expect(reason.textContent).not.toMatch(/\d/);
  });

  it("renders no reason line at all when the server sends no reason codes", async () => {
    sessionHolder.current = fakeSession;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, { ...suggestionBody, result: { ...suggestionBody.result, reasonCodes: [] } }),
      ),
    );

    const { container } = render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    expect(screen.queryByText(/^Valt för att/)).toBeNull();
    // #183: absent, not empty. An element left standing with no text would hold its
    // margin open and leave a gap where the household is told nothing.
    expect(container.querySelector(".suggestion__reason")).toBeNull();
  });

  it("Laga ikväll moves to the shopping list, and a page reload restores it directly", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, suggestionBody)));

    const { unmount } = render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "Laga ikväll" }));

    // The shopping list, not the old dead-end confirmation text.
    await screen.findByRole("heading", { name: "Behöver handlas (2)" });
    expect(screen.getByText("För 2 portioner")).toBeTruthy();

    // Simulate a reload: unmount and mount a fresh App against the same session
    // and the same fetch response. It must land straight back on the shopping
    // list, not the suggestion card, because a stored list for this template id
    // already exists.
    unmount();
    render(<App />);
    await screen.findByRole("heading", { name: "Behöver handlas (2)" });
    expect(screen.queryByRole("heading", { name: "Kycklinggryta", level: 3 })).toBeNull();
  });

  const labelByTier: Record<CostTier, string> = { budget: "Billig", mid: "Mellan", premium: "Dyr" };

  for (const [tier, label] of Object.entries(labelByTier) as [CostTier, string][]) {
    it(`exposes "${label}" as the accessible name for cost tier "${tier}"`, async () => {
      sessionHolder.current = fakeSession;
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, suggestionBodyForTier(tier))));

      render(<App />);
      await screen.findByRole("heading", { name: "Kycklinggryta" });

      expect(screen.getByRole("img", { name: label })).toBeTruthy();
    });
  }
});

function suggestionBodyFor(id: string, name: string, cuisine = "swedish_nordic") {
  return {
    result: {
      template: { id, name, blurb: `Testblurb för ${name.toLowerCase()}.`, cost_tier: "budget", prep_time_band: "<20min", cuisine },
      ingredients: [{ role: "protein", name: "Torsk", slotIndex: 0, ingredientId: "torsk", substituted: false, allergens: [], quantity: { kind: "amount", amount: 400, unit: "g" } }],
      substitutions: [],
      score: 0.3,
      cookedToday: false,
    },
    portions: 2,
  };
}

const exhaustedBody = { result: null, reason: "no_more_suggestions", portions: 2 };


// The chip row's state machine is unit-tested in refinement.test.ts; these cover
// the wiring the reducer can't see — what reaches the network, what the chip's
// accessible name says, and that the exhausted path stays recoverable.
describe("App — adjustment chips", () => {
  it("sends everything shown so far as exclude and the current dish as previous, and renders the new dish", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, suggestionBody))
      .mockResolvedValueOnce(jsonResponse(200, suggestionBodyFor("fisksoppa", "Fisksoppa")));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "Byt förslag" }));

    await screen.findByRole("heading", { name: "Fisksoppa" });
    const nextUrl = fetchMock.mock.calls[1]![0] as string;
    expect(nextUrl).toContain("exclude=kycklinggryta");
    expect(nextUrl).toContain("previous=kycklinggryta");
  });

  it("never repeats a dish across repeated presses, accumulating exclude each time", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, suggestionBody))
      .mockResolvedValueOnce(jsonResponse(200, suggestionBodyFor("fisksoppa", "Fisksoppa")))
      .mockResolvedValueOnce(jsonResponse(200, suggestionBodyFor("linssoppa", "Linssoppa")));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "Byt förslag" }));
    await screen.findByRole("heading", { name: "Fisksoppa" });
    expect(screen.queryByRole("heading", { name: "Kycklinggryta" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Byt förslag" }));
    await screen.findByRole("heading", { name: "Linssoppa" });
    expect(screen.queryByRole("heading", { name: "Fisksoppa" })).toBeNull();

    const thirdUrl = fetchMock.mock.calls[2]![0] as string;
    expect(thirdUrl).toContain("exclude=kycklinggryta%2Cfisksoppa");
    expect(thirdUrl).toContain("previous=fisksoppa");
  });

  it("raises the price weight, keeps the chip pressed, and announces its level", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, suggestionBody))
      .mockResolvedValueOnce(jsonResponse(200, suggestionBodyFor("linssoppa", "Linssoppa")))
      .mockResolvedValueOnce(jsonResponse(200, suggestionBodyFor("artsoppa", "Ärtsoppa")));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    expect(screen.getByRole("button", { name: "Billigare, nivå 0 av 2" }).getAttribute("aria-pressed")).toBe("false");

    await user.click(screen.getByRole("button", { name: "Billigare, nivå 0 av 2" }));
    await screen.findByRole("heading", { name: "Linssoppa" });
    expect((fetchMock.mock.calls[1]![0] as string)).toContain(`price=${WEIGHT_LEVELS[1]}`);

    // Still pressed and still showing its level a reroll later — the whole point
    // of chip state being session-persistent rather than per-request.
    const pressed = screen.getByRole("button", { name: "Billigare, nivå 1 av 2" });
    expect(pressed.getAttribute("aria-pressed")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Byt förslag" }));
    await screen.findByRole("heading", { name: "Ärtsoppa" });
    expect(screen.getByRole("button", { name: "Billigare, nivå 1 av 2" })).toBeTruthy();
    expect((fetchMock.mock.calls[2]![0] as string)).toContain(`price=${WEIGHT_LEVELS[1]}`);
  });

  it("cycles through both levels and wraps back to 0 in one more tap, each tap requesting a new suggestion", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: string) =>
      jsonResponse(200, suggestionBodyFor(`dish-${url.length}`, `Dish ${url.length}`)),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, suggestionBody));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "Snabbare, nivå 0 av 2" }));
    await screen.findByRole("button", { name: "Snabbare, nivå 1 av 2" });

    await user.click(screen.getByRole("button", { name: "Snabbare, nivå 1 av 2" }));
    const atMax = await screen.findByRole("button", { name: "Snabbare, nivå 2 av 2, högsta nivån" });
    expect(atMax.getAttribute("aria-pressed")).toBe("true");

    const callsAtMax = fetchMock.mock.calls.length;
    await user.click(atMax);

    const wrapped = await screen.findByRole("button", { name: "Snabbare, nivå 0 av 2" });
    expect(wrapped.getAttribute("aria-pressed")).toBe("false");
    // The wrap-to-0 tap is not a no-op — it re-requests like every other tap.
    expect(fetchMock.mock.calls.length).toBe(callsAtMax + 1);
  });

  it("Annat kök skips a same-cuisine suggestion and excludes it too", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, suggestionBody))
      .mockResolvedValueOnce(jsonResponse(200, suggestionBodyFor("raggmunk", "Raggmunk")))
      .mockResolvedValueOnce(
        jsonResponse(200, suggestionBodyFor("tacos", "Tacos", "mexican_texmex")),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "Annat kök" }));

    await screen.findByRole("heading", { name: "Tacos" });
    // The rejected same-cuisine dish never rendered, and is excluded from here on.
    expect((fetchMock.mock.calls[2]![0] as string)).toContain("exclude=kycklinggryta%2Craggmunk");
    // Cuisine is resolved client-side — it must never reach the API.
    expect(fetchMock.mock.calls.every(([url]) => !(url as string).includes("cuisine"))).toBe(true);
  });

  it("renders the recoverable empty state, and Återställ restores a fresh suggestion", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, suggestionBody))
      .mockResolvedValueOnce(jsonResponse(200, exhaustedBody))
      .mockResolvedValueOnce(jsonResponse(200, suggestionBody));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "Byt förslag" }));
    await screen.findByRole("heading", { name: "Du har sett kvällens hela urval" });
    expect(screen.queryByRole("heading", { name: "Kycklinggryta" })).toBeNull();
    // Recoverable, not an error and not a blank card.
    expect(screen.queryByRole("alert")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Återställ" }));
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    // Reset re-requests with no exclusions and no weights at all.
    const resetUrl = fetchMock.mock.calls[2]![0] as string;
    expect(resetUrl).not.toContain("exclude=");
    expect(resetUrl).not.toContain("price=");
  });

  it("Återställ clears a raised weight back to level 0", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, suggestionBody))
      .mockResolvedValueOnce(jsonResponse(200, suggestionBodyFor("linssoppa", "Linssoppa")))
      .mockResolvedValueOnce(jsonResponse(200, suggestionBody));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "Billigare, nivå 0 av 2" }));
    await screen.findByRole("button", { name: "Billigare, nivå 1 av 2" });

    await user.click(screen.getByRole("button", { name: "Återställ" }));
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    const restored = screen.getByRole("button", { name: "Billigare, nivå 0 av 2" });
    expect(restored.getAttribute("aria-pressed")).toBe("false");
  });

  it("offers Återställ only while something is actually raised", async () => {
    // #183: the adjust row holds controls that do something right now. A permanent
    // reset chip beside three chips at zero is a control for undoing nothing, and it
    // takes a slot in the row that a real choice could have had.
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, suggestionBody))
      .mockResolvedValueOnce(jsonResponse(200, suggestionBodyFor("linssoppa", "Linssoppa")))
      .mockResolvedValueOnce(jsonResponse(200, suggestionBody));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    expect(screen.queryByRole("button", { name: "Återställ" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Snabbare, nivå 0 av 2" }));
    await screen.findByRole("button", { name: "Snabbare, nivå 1 av 2" });
    expect(screen.getByRole("button", { name: "Återställ" })).toBeTruthy();

    // And gone again once the session is back to neutral, rather than lingering as
    // the one chip that never turns off.
    await user.click(screen.getByRole("button", { name: "Återställ" }));
    await screen.findByRole("button", { name: "Snabbare, nivå 0 av 2" });
    expect(screen.queryByRole("button", { name: "Återställ" })).toBeNull();
  });

  it("counts Återställ as active for any of the three axes, not just price", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, suggestionBody))
        .mockResolvedValue(jsonResponse(200, suggestionBodyFor("linssoppa", "Linssoppa"))),
    );

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "Testa nytt, nivå 0 av 2" }));
    await screen.findByRole("button", { name: "Testa nytt, nivå 1 av 2" });

    expect(screen.getByRole("button", { name: "Återställ" })).toBeTruthy();
  });
});

describe("App — refinement instrumentation", () => {
  afterEach(() => setAnalyticsSink(null));

  it("reports each chip tap with the resulting weights and reroll depth", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const events: AnalyticsEvent[] = [];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, suggestionBody))
      .mockResolvedValueOnce(jsonResponse(200, suggestionBodyFor("linssoppa", "Linssoppa")))
      .mockResolvedValueOnce(jsonResponse(200, suggestionBodyFor("artsoppa", "Ärtsoppa")));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });
    // Installed after mount, so it overrides the real HTTP sink TonightView's own
    // effect just installed.
    setAnalyticsSink((event) => events.push(event));

    await user.click(screen.getByRole("button", { name: "Billigare, nivå 0 av 2" }));
    await screen.findByRole("heading", { name: "Linssoppa" });
    await user.click(screen.getByRole("button", { name: "Byt förslag" }));
    await screen.findByRole("heading", { name: "Ärtsoppa" });

    expect(events).toEqual([
      {
        name: "refinement_chip_tap",
        chip: "cheaper",
        weights: { price: WEIGHT_LEVELS[1], time: 0, variation: 0 },
        level: 1,
        rerollDepth: 1,
      },
      {
        name: "refinement_chip_tap",
        chip: "something_else",
        weights: { price: WEIGHT_LEVELS[1], time: 0, variation: 0 },
        level: undefined,
        rerollDepth: 2,
      },
    ]);
  });

  it("reports a session that ends without an acceptance, with its final depth", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const events: AnalyticsEvent[] = [];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, suggestionBody))
      .mockResolvedValueOnce(jsonResponse(200, suggestionBodyFor("linssoppa", "Linssoppa")));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });
    setAnalyticsSink((event) => events.push(event));
    await user.click(screen.getByRole("button", { name: "Byt förslag" }));
    await screen.findByRole("heading", { name: "Linssoppa" });

    window.dispatchEvent(new Event("pagehide"));

    expect(events.at(-1)).toEqual({ name: "refinement_session_abandoned", rerollDepth: 1 });
  });

  it("reports nothing on leaving once a suggestion has been chosen", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const events: AnalyticsEvent[] = [];

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, suggestionBody));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });
    setAnalyticsSink((event) => events.push(event));
    await user.click(screen.getByRole("button", { name: "Laga ikväll" }));

    window.dispatchEvent(new Event("pagehide"));

    expect(events.filter((event) => event.name === "refinement_session_abandoned")).toEqual([]);
  });
});

describe("App — Laga ikväll", () => {
  afterEach(() => setAnalyticsSink(null));

  /** Tonight first, then whatever the POST /api/cooked call should answer with. */
  function fetchWithCooked(cookedResponse: Response) {
    return vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, suggestionBody))
      .mockResolvedValueOnce(cookedResponse);
  }

  const cookedOk = jsonResponse(200, {
    cooked: { templateId: "kycklinggryta", cookedAt: "2026-08-05T18:00:00.000Z" },
  });

  it("posts the dish and its substitutions, and moves straight to the shopping list — accepting and marking cooked are the same tap (#142)", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = fetchWithCooked(cookedOk);
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });
    await user.click(screen.getByRole("button", { name: "Laga ikväll" }));

    await screen.findByRole("heading", { name: "Behöver handlas (2)" });

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("/api/cooked");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      templateId: "kycklinggryta",
      substitutions: [],
    });
  });

  it("navigates to the shopping list even when the history write fails, without showing the error in the UI", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = fetchWithCooked(
      jsonResponse(404, { error: { code: "household_not_found", message: "inget hushåll" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });
    await user.click(screen.getByRole("button", { name: "Laga ikväll" }));

    // A failed history write is nothing the household can act on (DECISION_LOG
    // 2026-08-16) — it must not block the shopping list or surface as an alert.
    await screen.findByRole("heading", { name: "Behöver handlas (2)" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a failed history write as its own analytics event instead of meal_chosen failing loudly", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const events: AnalyticsEvent[] = [];
    const fetchMock = fetchWithCooked(
      jsonResponse(404, { error: { code: "household_not_found", message: "inget hushåll" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });
    setAnalyticsSink((event) => events.push(event));
    await user.click(screen.getByRole("button", { name: "Laga ikväll" }));
    await screen.findByRole("heading", { name: "Behöver handlas (2)" });

    expect(events).toEqual([
      { name: "meal_chosen", templateId: "kycklinggryta", rerollDepth: 0 },
      { name: "meal_choice_history_failed", templateId: "kycklinggryta" },
    ]);
  });

  it("instruments meal_chosen with the reroll depth it took to get there", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const events: AnalyticsEvent[] = [];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, suggestionBody))
      .mockResolvedValueOnce(jsonResponse(200, suggestionBodyFor("fisksoppa", "Fisksoppa")))
      .mockResolvedValueOnce(
        jsonResponse(200, { cooked: { templateId: "fisksoppa", cookedAt: "2026-08-05T18:00:00.000Z" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });
    // Installed after mount, so it overrides the real HTTP sink TonightView's own
    // effect just installed — the same override order setAnalyticsSink is always
    // used with in these tests, per its own doc comment.
    setAnalyticsSink((event) => events.push(event));
    await user.click(screen.getByRole("button", { name: "Byt förslag" }));
    await screen.findByRole("heading", { name: "Fisksoppa" });
    await user.click(screen.getByRole("button", { name: "Laga ikväll" }));
    await screen.findByRole("heading", { name: /Behöver handlas/ });

    expect(events.at(-1)).toEqual({
      name: "meal_chosen",
      templateId: "fisksoppa",
      rerollDepth: 1,
    });
  });
});

// A rejected fetch here mirrors what the real browser fetch() does with no
// connection (a thrown TypeError, never a resolved Response) — the case
// App.tsx's toGateState() must route to "offline", not the generic "error"
// state (issue #93, UX_FLOW §7).
const offlineFetch = () => vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

describe("App — the cook screen (#154)", () => {
  const STEPS = [
    "Skär kycklingen i bitar.",
    "Hacka rödlöken.",
    "Hetta upp en stekpanna.",
    "Bryn kycklingen.",
    "Tillsätt rödlöken.",
    "Låt allt sjuda klart.",
  ];

  /** Tonight, then the cooked write, then whatever /api/instructions should answer. */
  function fetchThrough(instructions: Response) {
    return vi.fn((url: string) => {
      if (typeof url === "string" && url.startsWith("/api/instructions")) {
        return Promise.resolve(instructions);
      }
      if (typeof url === "string" && url.startsWith("/api/cooked")) {
        return Promise.resolve(
          jsonResponse(200, {
            cooked: { templateId: "kycklinggryta", cookedAt: "2026-08-18T18:00:00.000Z" },
          }),
        );
      }
      return Promise.resolve(jsonResponse(200, suggestionBody));
    });
  }

  it("goes Tonight → list → cook, carrying the curated dish data across", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal("fetch", fetchThrough(jsonResponse(200, { instructions: STEPS })));

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });
    await user.click(screen.getByRole("button", { name: "Laga ikväll" }));
    await screen.findByRole("heading", { name: "Behöver handlas (2)" });

    await user.click(screen.getByRole("button", { name: "Börja laga" }));

    expect(await screen.findByText(STEPS[0]!)).toBeTruthy();
    // Curated data made the trip: the amount is the engine's, the time is the
    // template's band — neither is re-derived on this screen.
    expect(screen.getAllByText("400 g").length).toBeGreaterThan(0);
    expect(screen.getByText(/20–40 min/)).toBeTruthy();
  });

  it("resumes a cold open of /laga/:id from what is stored on the device", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal("fetch", fetchThrough(jsonResponse(200, { instructions: STEPS })));

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });
    await user.click(screen.getByRole("button", { name: "Laga ikväll" }));
    await screen.findByRole("heading", { name: "Behöver handlas (2)" });
    await user.click(screen.getByRole("button", { name: "Börja laga" }));
    await screen.findByText(STEPS[0]!);
    cleanup();

    // A reload lands on the route with no navigation state at all — the shape a
    // bookmark, a refresh mid-cook, or an offline start all take.
    window.history.replaceState(null, "", "/laga/kycklinggryta");
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    render(<App />);

    expect(await screen.findByText(STEPS[0]!)).toBeTruthy();
    expect(screen.getByText("Kycklinggryta")).toBeTruthy();
  });

  it("cooks the plan currently in hand, not an older cook record's amounts", async () => {
    sessionHolder.current = fakeSession;
    // The device has both: a cook record from an earlier, smaller evening, and a
    // shopping list for the same dish planned since. A cold open of /laga/:id must
    // take the amounts from the list — the plan in hand — or the household cooks
    // last week's portions.
    saveCookRecord({
      version: 1,
      templateId: "kycklinggryta",
      substitutionKey: substitutionKey([]),
      substitutions: [],
      name: "Kycklinggryta",
      prepTimeBand: "20-40min",
      portions: 2,
      ingredients: [{ name: "Kyckling", quantity: { kind: "amount", amount: 400, unit: "g" } }],
      steps: STEPS,
    });
    saveShoppingList({
      version: SHOPPING_LIST_VERSION,
      templateId: "kycklinggryta",
      templateName: "Kycklinggryta",
      substitutions: [],
      items: [
        {
          name: "Kyckling",
          section: "to_buy",
          bought: false,
          allergens: [],
          quantity: { kind: "amount", amount: 900, unit: "g" },
          slotIndex: 0,
          ingredientId: "kyckling",
        },
      ],
    });

    window.history.replaceState(null, "", "/laga/kycklinggryta");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(200, suggestionBody))));

    render(<App />);

    expect(await screen.findByText(STEPS[0]!)).toBeTruthy();
    expect(screen.getByText("900 g")).toBeTruthy();
    expect(screen.queryByText("400 g")).toBeNull();
    // The curated band still comes from the record — the shopping list never stored
    // one, and the substitution sets match, so it is the same dish.
    expect(screen.getByText(/20–40 min/)).toBeTruthy();
  });

  it("shows a way out when the route names a dish the device knows nothing about", async () => {
    sessionHolder.current = fakeSession;
    window.history.replaceState(null, "", "/laga/en-okand-ratt");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(200, suggestionBody))));

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Ingen middag att laga" })).toBeTruthy();
  });
});

describe("App — entering the guided flow", () => {
  it("opens the guided flow from the bottom nav and comes back", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/guided/options")) {
        return jsonResponse(200, { mainIngredients: [], pantryIngredients: [] });
      }
      return jsonResponse(200, suggestionBody);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Ikväll" });

    // #183: Tonight no longer carries its own entrance — the nav's Bygg tab is the
    // only one, so the button that used to duplicate it cannot compete with "Laga
    // ikväll" any more.
    await user.click(screen.getByRole("link", { name: "Bygg" }));
    await screen.findByRole("heading", { name: "Vad är du sugen på?" });

    await user.click(screen.getByRole("button", { name: "Till ikväll" }));
    expect(await screen.findByRole("heading", { name: "Ikväll" })).toBeTruthy();
  });

  it("reopens a guided shopping list left on the device rather than losing it", async () => {
    // A reload in the shop after choosing a guided direction (UX_FLOW §7). The list
    // belongs to a dish the Tonight response knows nothing about, so the Tonight card
    // cannot restore it — the app must land back on it anyway.
    sessionHolder.current = fakeSession;
    localStorage.setItem(
      "matmatch.shoppingList",
      JSON.stringify({
        version: 4,
        templateId: "nagot-annat",
        templateName: "Svartbönsgryta",
        substitutions: [],
        items: [{ name: "Svarta bönor", section: "to_buy", bought: false, allergens: [], quantity: { kind: "amount", amount: 400, unit: "g" }, slotIndex: 0, ingredientId: "svarta-bonor" }],
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("/api/guided/options")
          ? jsonResponse(200, { mainIngredients: [], pantryIngredients: [] })
          : jsonResponse(200, suggestionBody),
      ),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Svartbönsgryta" })).toBeTruthy();
    expect(screen.getByText("Behöver handlas (1)")).toBeTruthy();
  });

  it("also lands on the list when the stored list is the Tonight suggestion's own (#137)", async () => {
    // Same redirect as the mismatched case above — /lista is now the one place a
    // stored list resumes, whether it belongs to tonight's own suggestion or not.
    sessionHolder.current = fakeSession;
    localStorage.setItem(
      "matmatch.shoppingList",
      JSON.stringify({
        version: 4,
        templateId: "kycklinggryta",
        items: [{ name: "Kyckling", section: "to_buy", bought: false, allergens: [], quantity: { kind: "amount", amount: 400, unit: "g" }, slotIndex: 0, ingredientId: "kyckling" }],
      }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, suggestionBody)));

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Behöver handlas (1)" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Lista" }).getAttribute("aria-current")).toBe("page");
  });
});

describe("App — offline", () => {
  it("shows a clear 'no connection' state, never a blank screen or a raw error, when there is no saved list", async () => {
    sessionHolder.current = fakeSession;
    vi.stubGlobal("fetch", offlineFetch());

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Ingen anslutning" })).toBeTruthy();
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Anslut till internet för att komma igång.");
    expect(screen.queryByRole("heading", { name: "Ikväll" })).toBeNull();
  });

  it("retrying after reconnecting re-fetches and reaches Tonight", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse(200, suggestionBody));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("status");

    await user.click(screen.getByRole("button", { name: "Försök igen" }));

    await screen.findByRole("heading", { name: "Kycklinggryta" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("renders the persisted shopping list from local storage instead of the error/onboarding state", async () => {
    sessionHolder.current = fakeSession;
    localStorage.setItem(
      "matmatch.shoppingList",
      JSON.stringify({
        version: 4,
        templateId: "kycklinggryta",
        items: [
          { name: "Kyckling", section: "to_buy", bought: false, allergens: [], quantity: { kind: "amount", amount: 400, unit: "g" }, slotIndex: 0, ingredientId: "kyckling" },
          { name: "Ris", section: "have_at_home", bought: false, allergens: [], quantity: { kind: "amount", amount: 400, unit: "g" }, slotIndex: 1, ingredientId: "ris" },
        ],
      }),
    );
    vi.stubGlobal("fetch", offlineFetch());

    render(<App />);

    await screen.findByText("Ingen anslutning — visar din sparade inköpslista.");
    expect(screen.getByRole("heading", { name: "Behöver handlas (1)" })).toBeTruthy();
    expect(screen.getByText("Kyckling")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Har hemma (1)" })).toBeTruthy();
    expect(screen.getByText("Ris")).toBeTruthy();
  });

  it("checking an item off the offline list persists it back to storage", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    localStorage.setItem(
      "matmatch.shoppingList",
      JSON.stringify({
        version: 4,
        templateId: "kycklinggryta",
        items: [{ name: "Kyckling", section: "to_buy", bought: false, allergens: [], quantity: { kind: "amount", amount: 400, unit: "g" }, slotIndex: 0, ingredientId: "kyckling" }],
      }),
    );
    vi.stubGlobal("fetch", offlineFetch());

    render(<App />);
    const checkbox = await screen.findByRole("checkbox");
    await user.click(checkbox);

    const stored = JSON.parse(localStorage.getItem("matmatch.shoppingList")!);
    expect(stored.items[0].bought).toBe(true);
  });
});

// #137: the install affordance moved from a bar above the whole app to the
// Profil tab, so these now navigate there first via the bottom nav.
describe("App — install prompt", () => {
  it("shows no install button until the browser fires beforeinstallprompt", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, suggestionBody)));

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });
    await user.click(screen.getByRole("link", { name: "Profil" }));

    expect(screen.queryByRole("button", { name: "Installera appen" })).toBeNull();
  });

  it("shows the install button after beforeinstallprompt fires, and prompts on click", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, suggestionBody)));

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });
    await user.click(screen.getByRole("link", { name: "Profil" }));

    const promptSpy = vi.fn().mockResolvedValue(undefined);
    const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
      prompt: () => Promise<void>;
    };
    event.prompt = promptSpy;
    window.dispatchEvent(event);

    const installButton = await screen.findByRole("button", { name: "Installera appen" });
    await user.click(installButton);

    expect(promptSpy).toHaveBeenCalledTimes(1);
  });
});

describe("App — the Tonight card's diner picker (#112)", () => {
  const twoDiners = [{ label: "Vuxen 1" }, { label: "Elsa" }];

  function suggestionWithDiners(
    id: string,
    diners: { label: string }[] = twoDiners,
    portions = 2,
  ) {
    return {
      result: {
        template: {
          id,
          name: id,
          blurb: `Testblurb för ${id}.`,
          cost_tier: "mid",
          prep_time_band: "20-40min",
          cuisine: "swedish_nordic",
        },
        ingredients: [{ role: "protein", name: "Kyckling", slotIndex: 0, ingredientId: "kyckling", substituted: false, allergens: [], quantity: { kind: "amount", amount: 400, unit: "g" } }],
        substitutions: [],
        score: 0.5,
        cookedToday: false,
      },
      portions,
      diners,
    };
  }

  /** Every /api/tonight request answered with `body`; anything else is a no-op 200. */
  function stubTonight(...bodies: unknown[]) {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/tonight")) {
        return jsonResponse(200, bodies.length > 1 ? bodies.shift() : bodies[0]);
      }
      return jsonResponse(200, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function tonightQueries(fetchMock: ReturnType<typeof vi.fn>): URLSearchParams[] {
    return fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.startsWith("/api/tonight"))
      .map((url) => new URLSearchParams(url.split("?")[1] ?? ""));
  }

  it("stays zero-input: the first request sends no diner parameter and a dish is shown", async () => {
    // Condition 2 at the surface that has to honour it most: Tonight must produce a
    // suggestion before anyone has said who is eating.
    sessionHolder.current = fakeSession;
    const fetchMock = stubTonight(suggestionWithDiners("kycklinggryta"));

    render(<App />);

    await screen.findByRole("heading", { name: "kycklinggryta" });
    expect(tonightQueries(fetchMock)[0]!.get("diners")).toBeNull();
  });

  it("shows every member selected by default", async () => {
    sessionHolder.current = fakeSession;
    stubTonight(suggestionWithDiners("kycklinggryta"));

    render(<App />);

    await screen.findByRole("heading", { name: "kycklinggryta" });
    expect(screen.getByRole("button", { name: "Vuxen 1", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Elsa", pressed: true })).toBeTruthy();
  });

  it("re-asks with the narrowed diner set when a member is deselected", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = stubTonight(
      suggestionWithDiners("kycklinggryta"),
      suggestionWithDiners("jordnotsgryta", twoDiners, 1),
    );

    render(<App />);
    await screen.findByRole("heading", { name: "kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "Elsa" }));

    await screen.findByRole("heading", { name: "jordnotsgryta" });
    const last = tonightQueries(fetchMock).at(-1)!;
    expect(last.get("diners")).toBe("0");
    // The exclusion set survives the change: a dish the household already rejected
    // does not become interesting again because somebody left the table.
    expect(last.get("exclude")).toContain("kycklinggryta");
  });

  it("cannot deselect the last remaining diner", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    stubTonight(suggestionWithDiners("kycklinggryta"));

    render(<App />);
    await screen.findByRole("heading", { name: "kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "Elsa" }));
    const last = await screen.findByRole("button", { name: "Vuxen 1", pressed: true });

    expect((last as HTMLButtonElement).disabled).toBe(true);
  });

  it("resets to everyone when the roster changes underneath the session", async () => {
    // Positional identity, closed rather than documented: a member *is* its index, so
    // a selection made against one roster must not be reinterpreted against another.
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = stubTonight(
      suggestionWithDiners("kycklinggryta"),
      // The refetch comes back with a *different* household — a member was added.
      suggestionWithDiners("pasta", [...twoDiners, { label: "Barn 1" }], 2.5),
      suggestionWithDiners("pasta", [...twoDiners, { label: "Barn 1" }], 2.5),
    );

    render(<App />);
    await screen.findByRole("heading", { name: "kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "Elsa" }));
    await screen.findByRole("heading", { name: "pasta" });

    // All three members eating again, and the next request carries no diner set —
    // the stale selection was discarded, not carried onto a different roster.
    for (const label of ["Vuxen 1", "Elsa", "Barn 1"]) {
      expect(screen.getByRole("button", { name: label, pressed: true })).toBeTruthy();
    }
    await vi.waitFor(() => expect(tonightQueries(fetchMock).at(-1)!.get("diners")).toBeNull());
  });

  it("renders no picker for a one-member household", async () => {
    sessionHolder.current = fakeSession;
    stubTonight(suggestionWithDiners("kycklinggryta", [{ label: "Vuxen 1" }], 1));

    render(<App />);

    await screen.findByRole("heading", { name: "kycklinggryta" });
    expect(screen.queryByRole("group", { name: "Vilka äter?" })).toBeNull();
  });

  it("names the cross-contamination limit rather than implying it is handled", async () => {
    sessionHolder.current = fakeSession;
    stubTonight(suggestionWithDiners("kycklinggryta"));

    render(<App />);

    await screen.findByRole("heading", { name: "kycklinggryta" });
    expect(
      screen.getByText(/Rester och gemensamma kastruller kan ändå innehålla allergener/),
    ).toBeTruthy();
  });

  it("writes nothing to localStorage and never posts to the household", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = stubTonight(suggestionWithDiners("kycklinggryta"));

    render(<App />);
    await screen.findByRole("heading", { name: "kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "Elsa" }));
    await user.click(await screen.findByRole("button", { name: "Elsa", pressed: false }));

    expect(localStorage.length).toBe(0);
    const households = fetchMock.mock.calls.filter((call) =>
      String(call[0]).startsWith("/api/households"),
    );
    expect(households).toEqual([]);
  });
});

describe("App — a diner change keeps the dish when it is still valid (#133)", () => {
  const twoDiners = [{ label: "Vuxen 1" }, { label: "Elsa" }];

  function suggestion(id: string, extra: { replacedFor?: string } = {}) {
    return {
      result: {
        template: {
          id,
          name: id,
          blurb: `Testblurb för ${id}.`,
          cost_tier: "mid",
          prep_time_band: "20-40min",
          cuisine: "swedish_nordic",
        },
        ingredients: [
          {
            role: "protein",
            name: "Kyckling",
            slotIndex: 0,
            ingredientId: "kyckling",
            substituted: false,
            allergens: [],
            quantity: { kind: "amount", amount: 400, unit: "g" },
          },
        ],
        substitutions: [],
        score: 0.5,
        cookedToday: false,
      },
      portions: 2,
      diners: twoDiners,
      ...extra,
    };
  }

  function stubTonight(...bodies: unknown[]) {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/tonight")) {
        return jsonResponse(200, bodies.length > 1 ? bodies.shift() : bodies[0]);
      }
      return jsonResponse(200, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function tonightQueries(fetchMock: ReturnType<typeof vi.fn>): URLSearchParams[] {
    return fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.startsWith("/api/tonight"))
      .map((url) => new URLSearchParams(url.split("?")[1] ?? ""));
  }

  it("asks the server to keep the dish on screen, not to reroll away from it", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = stubTonight(suggestion("kycklinggryta"), suggestion("kycklinggryta"));

    render(<App />);
    await screen.findByRole("heading", { name: "kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "Elsa" }));
    await vi.waitFor(() => expect(tonightQueries(fetchMock)).toHaveLength(2));

    const last = tonightQueries(fetchMock).at(-1)!;
    expect(last.get("keep")).toBe("kycklinggryta");
    expect(last.get("previous")).toBeNull();
  });

  it("regression: a diner change that leaves the dish valid does not change the dish", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    stubTonight(suggestion("kycklinggryta"), suggestion("kycklinggryta"));

    render(<App />);
    await screen.findByRole("heading", { name: "kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "Elsa" }));

    // Still the same dish, and no replacement notice — nothing to explain.
    await screen.findByRole("button", { name: "Elsa", pressed: false });
    expect(screen.getByRole("heading", { name: "kycklinggryta" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: /Rätten passar inte/ })).toBeNull();
    expect(screen.queryByText(/Rätten passar inte/)).toBeNull();
  });

  it("shows the Swedish reason and the new dish when the server had to replace it", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    stubTonight(
      suggestion("kycklinggryta"),
      suggestion("jordnotsgryta", { replacedFor: "Elsa" }),
    );

    render(<App />);
    await screen.findByRole("heading", { name: "kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "Vuxen 1" }));

    await screen.findByRole("heading", { name: "jordnotsgryta" });
    expect(
      screen.getByText("Rätten passar inte Elsa, här är ett nytt förslag"),
    ).toBeTruthy();
  });

  it("clears the replacement notice once the household does anything else", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    stubTonight(
      suggestion("kycklinggryta"),
      suggestion("jordnotsgryta", { replacedFor: "Elsa" }),
      suggestion("jordnotsgryta"),
    );

    render(<App />);
    await screen.findByRole("heading", { name: "kycklinggryta" });
    await user.click(screen.getByRole("button", { name: "Vuxen 1" }));
    await screen.findByText("Rätten passar inte Elsa, här är ett nytt förslag");

    await user.click(screen.getByRole("button", { name: "Byt förslag" }));

    await vi.waitFor(() =>
      expect(screen.queryByText(/Rätten passar inte/)).toBeNull(),
    );
  });
});

describe("App — a failed diner change never leaves the card and the picker disagreeing", () => {
  it("puts the selection back when the refetch fails", async () => {
    // The dangerous shape: the chips say the allergic member is eating again while the
    // dish on screen was chosen without her. Reverting keeps the two describing the
    // same meal, with the error above them.
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();

    let calls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (!String(url).startsWith("/api/tonight")) return jsonResponse(200, {});
      calls += 1;
      if (calls === 1) {
        return jsonResponse(200, {
          result: {
            template: {
              id: "kycklinggryta",
              name: "kycklinggryta",
              blurb: "Testblurb för kycklinggryta.",
              cost_tier: "mid",
              prep_time_band: "20-40min",
              cuisine: "swedish_nordic",
            },
            ingredients: [{ role: "protein", name: "Kyckling", slotIndex: 0, ingredientId: "kyckling", substituted: false, allergens: [], quantity: { kind: "amount", amount: 400, unit: "g" } }],
            substitutions: [],
            score: 0.5,
            cookedToday: false,
          },
          portions: 2,
          diners: [{ label: "Vuxen 1" }, { label: "Elsa" }],
        });
      }
      throw new TypeError("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "Elsa" }));

    // Back to everyone, and the dish that was served to everyone is still on screen.
    expect(await screen.findByRole("button", { name: "Elsa", pressed: true })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "kycklinggryta" })).toBeTruthy();
    // A network failure never reaches the DOM as raw text (#170).
    expect(screen.getByRole("alert").textContent).toBe(
      "Ingen anslutning. Anslut till internet och försök igen.",
    );
    expect(screen.queryByText("network down")).toBeNull();

    // And the revert does not re-fire the request that just failed.
    const before = fetchMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock.mock.calls.length).toBe(before);
  });
});

describe("App — bottom navigation (#137)", () => {
  it("reaches all four tabs, marks the active one, and keeps one analytics sink alive across them", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith("/api/guided/options")
        ? jsonResponse(200, { mainIngredients: [], pantryIngredients: [] })
        : jsonResponse(200, suggestionBody),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    // Installed once, on mount — not per screen.
    expect(createHttpAnalyticsSinkSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Ikväll" }).getAttribute("aria-current")).toBe("page");

    await user.click(screen.getByRole("link", { name: "Bygg" }));
    await screen.findByRole("heading", { name: "Vad är du sugen på?" });
    expect(screen.getByRole("link", { name: "Bygg" }).getAttribute("aria-current")).toBe("page");

    await user.click(screen.getByRole("link", { name: "Lista" }));
    await screen.findByRole("heading", { name: "Ingen middag vald ännu" });
    expect(screen.getByRole("link", { name: "Lista" }).getAttribute("aria-current")).toBe("page");

    await user.click(screen.getByRole("link", { name: "Profil" }));
    await screen.findByText("chef@example.com");
    expect(screen.getByRole("link", { name: "Profil" }).getAttribute("aria-current")).toBe("page");

    await user.click(screen.getByRole("link", { name: "Ikväll" }));
    await screen.findByRole("heading", { name: "Kycklinggryta" });
    expect(screen.getByRole("link", { name: "Ikväll" }).getAttribute("aria-current")).toBe("page");

    // Four tab switches later, still the one sink from mount — never torn down
    // and reinstalled, which would drop whatever it had buffered.
    expect(createHttpAnalyticsSinkSpy).toHaveBeenCalledTimes(1);
    expect(analyticsSinkHandle.stop).not.toHaveBeenCalled();
  });

  it("hides the bottom nav during onboarding", async () => {
    sessionHolder.current = fakeSession;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(householdNotFound));

    render(<App />);
    await screen.findByRole("heading", { name: "Vilka bor här?" });

    expect(screen.queryByRole("navigation", { name: "Huvudnavigation" })).toBeNull();
  });
});

// #166: /profil as the household's real editing screen. Covers a fresh fetch on
// mount (never the Gate/onboarding data), the collapsed row showing *which*
// allergies apply, remove-member, a failed save retaining form state, and the
// safety-critical piece — Tonight refetching (never staying stale) after a save.
describe("App — the profile screen (#166)", () => {
  const ella = {
    type: "child",
    name: "Ella",
    portion_factor: 0.5,
    allergies: [],
    dietary_flags: [],
  };
  const niklas = {
    type: "adult",
    name: "Niklas",
    portion_factor: 1,
    allergies: [],
    dietary_flags: [],
  };

  function storedHousehold(members: unknown[]) {
    return {
      id: "h1",
      owner_user_id: "u1",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
      household: { members },
    };
  }

  /**
   * Routes each call by method + URL to a queue of responses, shifted one at a
   * time (repeating the last entry once a queue drains) — the profile screen's
   * mount fetch, its save, and Gate's own Tonight fetches all hit the same
   * `/api/*` paths a single blanket mock can't tell apart.
   */
  function routedFetch(queues: Record<string, Response[]>) {
    return vi.fn((url: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${url}`;
      const queue = queues[key];
      if (!queue || queue.length === 0) {
        throw new Error(`no mock response queued for ${key}`);
      }
      return Promise.resolve(queue.length > 1 ? queue.shift()! : queue[0]!);
    });
  }

  async function openProfil(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByRole("heading", { name: "Kycklinggryta" });
    await user.click(screen.getByRole("link", { name: "Profil" }));
  }

  it("fetches the household fresh on mount, not from the Tonight/onboarding response", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = routedFetch({
      "GET /api/tonight": [jsonResponse(200, suggestionBody)],
      "GET /api/households": [jsonResponse(200, storedHousehold([niklas, ella]))],
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await openProfil(user);

    await screen.findByText("1 vuxen + 1 barn", { exact: false });
    expect(fetchMock).toHaveBeenCalledWith("/api/households", expect.anything());
  });

  it("keeps preferences and allergies as two separate, differently-labelled groups", async () => {
    // #101/UX_FLOW §6. This invariant used to be asserted on onboarding, which no
    // longer carries preference chips at all (#168) — the profile is now the one
    // screen where the two groups stand together, so it is where flattening them
    // into a single chip row has to fail.
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /api/tonight": [jsonResponse(200, suggestionBody)],
        "GET /api/households": [jsonResponse(200, storedHousehold([ella]))],
      }),
    );

    render(<App />);
    await openProfil(user);
    await user.click(await screen.findByRole("button", { name: /Ella/ }));

    const groups = Array.from(document.querySelectorAll(".profile-member-detail fieldset"));
    expect(groups).toHaveLength(2);

    const [preferences, allergies] = groups as [HTMLFieldSetElement, HTMLFieldSetElement];
    expect(preferences.querySelector("legend")!.textContent).toBe("Kostpreferenser");
    // Distinct legend text plus a warning glyph — both non-colour signals, present
    // in the markup rather than only in the stylesheet.
    expect(allergies.querySelector("legend")!.textContent).toContain("Allergier");
    expect(allergies.querySelector("legend")!.textContent).toContain("⚠");
    expect(allergies.className).toContain("allergy-group");

    // And the two groups genuinely hold different chips, in the locked order.
    expect(Array.from(preferences.querySelectorAll("button")).map((b) => b.textContent)).toEqual([
      "Vegetariskt",
      "Veganskt",
      "Proteinrikt",
    ]);
    expect(Array.from(allergies.querySelectorAll("button")).map((b) => b.textContent)).toEqual(
      ALLERGIES.map((allergy) => ALLERGY_LABELS[allergy]),
    );
  });

  it("adding an allergy shows it in the collapsed row, by name — not a count", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /api/tonight": [jsonResponse(200, suggestionBody)],
        "GET /api/households": [jsonResponse(200, storedHousehold([ella]))],
      }),
    );

    render(<App />);
    await openProfil(user);

    const row = await screen.findByRole("button", { name: /^Ella/ });
    expect(row.textContent).toContain("Ella");
    expect(row.textContent).toContain("Barn");
    expect(row.textContent).not.toContain("Nötter");

    await user.click(row);
    await user.click(screen.getByRole("button", { name: ALLERGY_LABELS.tree_nuts }));

    expect(screen.getByRole("button", { name: /^Ella/ }).textContent).toContain(
      ALLERGY_LABELS.tree_nuts,
    );
  });

  it("removing a member drops their row", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /api/tonight": [jsonResponse(200, suggestionBody)],
        "GET /api/households": [jsonResponse(200, storedHousehold([niklas, ella]))],
      }),
    );

    render(<App />);
    await openProfil(user);

    await user.click(await screen.findByRole("button", { name: /^Ella/ }));
    await user.click(screen.getByRole("button", { name: "Ta bort Ella" }));

    expect(screen.queryByRole("button", { name: /^Ella/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Niklas/ })).toBeTruthy();
  });

  it("keeps the form's edits and shows the error when a save fails", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /api/tonight": [jsonResponse(200, suggestionBody)],
        "GET /api/households": [jsonResponse(200, storedHousehold([ella]))],
        "PUT /api/households": [
          jsonResponse(500, { error: { code: "internal_error", message: "server exploded" } }),
        ],
      }),
    );

    render(<App />);
    await openProfil(user);

    await user.click(await screen.findByRole("button", { name: /^Ella/ }));
    await user.click(screen.getByRole("button", { name: ALLERGY_LABELS.tree_nuts }));
    await user.click(screen.getByRole("button", { name: "Spara" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    // The edit survives the failed save — retrying does not mean re-selecting it.
    expect(screen.getByRole("button", { name: /^Ella/ }).textContent).toContain(
      ALLERGY_LABELS.tree_nuts,
    );
  });

  it("says the save needs internet when the request never reaches the network", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${url}`;
      if (key === "GET /api/tonight") return Promise.resolve(jsonResponse(200, suggestionBody));
      if (key === "GET /api/households") return Promise.resolve(jsonResponse(200, storedHousehold([ella])));
      return Promise.reject(new TypeError("Failed to fetch"));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await openProfil(user);

    await user.click(screen.getByRole("button", { name: "Spara" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("internet");
  });

  it("invalidates Tonight's current suggestion on save, and refetches so Ikväll never shows the stale dish", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const refreshedSuggestion = {
      ...suggestionBody,
      result: { ...suggestionBody.result, template: { ...suggestionBody.result.template, id: "sopp", name: "Svampsoppa" } },
    };
    const fetchMock = routedFetch({
      "GET /api/tonight": [jsonResponse(200, suggestionBody), jsonResponse(200, refreshedSuggestion)],
      "GET /api/households": [jsonResponse(200, storedHousehold([ella]))],
      "PUT /api/households": [jsonResponse(200, storedHousehold([ella]))],
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await openProfil(user);

    await user.click(screen.getByRole("button", { name: "Spara" }));

    // The refetch that follows a save happens right away — before the household
    // ever navigates back — so by the time Ikväll is reached the second Tonight
    // response is already in place, never the dish from before the edit.
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => url === "/api/tonight")).toHaveLength(2),
    );

    await user.click(screen.getByRole("link", { name: "Ikväll" }));

    await screen.findByRole("heading", { name: "Svampsoppa" });
    expect(screen.queryByRole("heading", { name: "Kycklinggryta" })).toBeNull();
  });

  it("shows a friendly error, never the raw code or message, when the household fails to load", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /api/tonight": [jsonResponse(200, suggestionBody)],
        "GET /api/households": [
          jsonResponse(500, { error: { code: "internal_error", message: "database on fire" } }),
        ],
      }),
    );

    render(<App />);
    await openProfil(user);

    expect(
      await screen.findByRole("heading", { name: "Det gick inte att hämta hushållet" }),
    ).toBeTruthy();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Något gick fel. Försök igen om en liten stund.");
    expect(screen.queryByText(/database on fire/)).toBeNull();
    expect(document.querySelector("pre")).toBeNull();
    expect(document.body.textContent).toContain("internal_error");
  });

  it("shows the offline state, not a blank screen, when the household can't be reached at all", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    let householdCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/tonight") return Promise.resolve(jsonResponse(200, suggestionBody));
        if (url === "/api/households") {
          householdCalls += 1;
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    render(<App />);
    await openProfil(user);

    expect(await screen.findByRole("heading", { name: "Ingen anslutning" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Anslut till internet för att komma igång.");
    expect(householdCalls).toBe(1);
  });
});

// #152 / #158 / #159: Tonight's lower half — the pantry row, "Testa nytt", and the
// collapsed preference block. The ordering rule and the copy rules are unit-tested
// elsewhere (src/engine/pantryOrdering.test.ts, preferenceHints.test.ts); these cover
// what only a rendered screen can show: what reaches the network, what survives a
// reload, what stays on screen mid-request, and what is deliberately not drawn.

const NEUTRAL_BASELINE = { price: 0, time: 0, variation: 0, simplicity: 0 };

const PANTRY_OPTIONS = [
  { id: "spagetti", name: "spagetti" },
  { id: "ris", name: "ris" },
  { id: "potatis", name: "potatis" },
  { id: "gul-lok", name: "gul lök" },
  { id: "matlagningsgradde", name: "matlagningsgrädde" },
  { id: "vitlok", name: "vitlök" },
  { id: "morot", name: "morot" },
  { id: "purjolok", name: "purjolök" },
];

function tonightBody(
  overrides: {
    pantryIngredients?: { id: string; name: string }[];
    preferenceWeights?: typeof NEUTRAL_BASELINE;
  } = {},
) {
  return {
    ...suggestionBody,
    pantryIngredients: overrides.pantryIngredients ?? PANTRY_OPTIONS,
    preferenceWeights: overrides.preferenceWeights ?? NEUTRAL_BASELINE,
  };
}

describe("App — Tonight's pantry row (#152)", () => {
  it("shows a handful of likely staples, not the whole catalog, and a way to the rest", async () => {
    sessionHolder.current = fakeSession;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, tonightBody()));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    const row = screen.getByRole("group", { name: "Varor hemma" });
    // Six chips plus "Fler" — a full picker here would be a screen-sized interruption
    // on the one screen that exists to avoid input.
    expect(within(row).getAllByRole("button")).toHaveLength(7);
    expect(within(row).getByRole("button", { name: "Fler" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "purjolök" })).toBeNull();
  });

  it("sends the tapped ingredients as pantry, and keeps the dish on screen while it re-ranks", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, tonightBody()))
      .mockResolvedValueOnce(
        jsonResponse(200, { ...suggestionBodyFor("fisksoppa", "Fisksoppa"), pantryIngredients: PANTRY_OPTIONS, preferenceWeights: NEUTRAL_BASELINE }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "spagetti" }));

    await screen.findByRole("heading", { name: "Fisksoppa" });
    expect(fetchMock.mock.calls[1]![0] as string).toContain("pantry=spagetti");
  });

  it("keeps the previous suggestion in the DOM for the whole re-ranking request", async () => {
    // The screen must never pass through an empty state: the household would lose
    // what they were reading, for a request that usually takes a moment.
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();

    let release: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, tonightBody()))
      .mockReturnValueOnce(pending);
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "ris" }));

    // Mid-request: still there, and visibly dimmed rather than replaced.
    expect(screen.getByRole("heading", { name: "Kycklinggryta" })).toBeTruthy();
    expect(document.querySelector(".tonight-suggestion.is-reranking")).toBeTruthy();

    release(
      jsonResponse(200, { ...suggestionBodyFor("fisksoppa", "Fisksoppa"), pantryIngredients: PANTRY_OPTIONS, preferenceWeights: NEUTRAL_BASELINE }),
    );
    await screen.findByRole("heading", { name: "Fisksoppa" });
    expect(document.querySelector(".tonight-suggestion.is-reranking")).toBeNull();
  });

  it("opens the guided flow's full grid in a layer, without leaving the suggestion", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, tonightBody()));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "Fler" }));

    const sheet = screen.getByRole("dialog", { name: "Vad har du hemma?" });
    expect(within(sheet).getByRole("button", { name: "purjolök" })).toBeTruthy();
    // The dish is still behind it — the layer is not a navigation.
    expect(screen.getByRole("heading", { name: "Kycklinggryta" })).toBeTruthy();

    await user.click(within(sheet).getByRole("button", { name: "Klar" }));
    expect(screen.queryByRole("dialog", { name: "Vad har du hemma?" })).toBeNull();
  });

  it("writes nothing anywhere — a reload starts with an empty pantry", async () => {
    // CLAUDE.md's non-negotiable: session-scoped and ephemeral. No localStorage, no
    // household write, and the fresh mount sends no pantry at all.
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, tonightBody()));
    vi.stubGlobal("fetch", fetchMock);

    const first = render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });
    await user.click(screen.getByRole("button", { name: "spagetti" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));

    expect(localStorage.length).toBe(0);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.method ?? "GET").toBe("GET");
    }

    // The reload.
    first.unmount();
    fetchMock.mockClear();
    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    expect(fetchMock.mock.calls[0]![0] as string).not.toContain("pantry=");
    const row = screen.getByRole("group", { name: "Varor hemma" });
    for (const chip of within(row).getAllByRole("button")) {
      expect(chip.getAttribute("aria-pressed")).not.toBe("true");
    }
  });

  it("explains the pick with the ingredient names the server sent", async () => {
    sessionHolder.current = fakeSession;
    const body = tonightBody();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        ...body,
        result: { ...body.result, reasonCodes: ["pantry_match"], pantryMatch: ["spagetti", "gul lök"] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    expect(screen.getByText("Valt för att du har spagetti och gul lök hemma.")).toBeTruthy();
  });
});

describe("App — Testa nytt (#153)", () => {
  it("moves the variation axis in the same notches the other chips use", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, tonightBody()))
      .mockResolvedValueOnce(
        jsonResponse(200, { ...suggestionBodyFor("fisksoppa", "Fisksoppa"), pantryIngredients: PANTRY_OPTIONS, preferenceWeights: NEUTRAL_BASELINE }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    await user.click(screen.getByRole("button", { name: /^Testa nytt/ }));

    await screen.findByRole("heading", { name: "Fisksoppa" });
    expect(fetchMock.mock.calls[1]![0] as string).toContain(`variation=${WEIGHT_LEVELS[1]}`);
  });

  it("expresses itself on the same axis the Variation slider does — same value, either way in", async () => {
    // The property that keeps the chip and the slider one mechanic: a chip tap to
    // level 1 and a baseline dragged to the same notch produce the same number on the
    // same axis. If these ever diverged there would be two ideas of "new".
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, tonightBody()))
      .mockResolvedValue(
        jsonResponse(200, { ...suggestionBodyFor("fisksoppa", "Fisksoppa"), pantryIngredients: PANTRY_OPTIONS, preferenceWeights: NEUTRAL_BASELINE }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    await user.click(screen.getByRole("button", { name: /^Testa nytt/ }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
    const viaChip = new URL(fetchMock.mock.calls[1]![0] as string, "http://x").searchParams.get(
      "variation",
    );

    // The same notch, arrived at through the slider instead.
    await user.click(screen.getByRole("button", { name: "Vad är viktigt för er?" }));
    const slider = screen.getByRole("slider", { name: /^Variation/ });
    expect(slider.getAttribute("max")).toBe("100");
    expect(slider.getAttribute("step")).toBe("5");
    expect(Number(viaChip)).toBe(WEIGHT_LEVELS[1]);
  });

  it("does not offer Enklare — the axis exists but has nothing behind it yet", async () => {
    sessionHolder.current = fakeSession;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, tonightBody()));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    expect(screen.queryByRole("button", { name: /Enklare/ })).toBeNull();
  });
});

describe("App — the preference block (#158, #159)", () => {
  async function openBlock() {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });
    // Awaited rather than queried: the baseline arrives on the Tonight response and is
    // seeded in an effect, so the block lands one tick after the dish.
    await user.click(await screen.findByRole("button", { name: "Vad är viktigt för er?" }));
    return user;
  }

  it("is collapsed on Tonight, showing nothing but its heading", async () => {
    sessionHolder.current = fakeSession;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, tonightBody()));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    const toggle = await screen.findByRole("button", { name: "Vad är viktigt för er?" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // Not merely hidden: three focusable controls behind a closed heading would be a
    // tab-order trap for anyone not using a pointer.
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
  });

  it("renders exactly three sliders — never the enkelhet one", async () => {
    sessionHolder.current = fakeSession;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, tonightBody()));
    vi.stubGlobal("fetch", fetchMock);

    await openBlock();

    expect(screen.getAllByRole("slider")).toHaveLength(3);
    expect(screen.getByRole("slider", { name: /^Pris/ })).toBeTruthy();
    expect(screen.getByRole("slider", { name: /^Tid/ })).toBeTruthy();
    expect(screen.getByRole("slider", { name: /^Variation/ })).toBeTruthy();
    expect(screen.queryByRole("slider", { name: /^Enkel/ })).toBeNull();
  });

  it("shows the household's stored baseline, not a neutral guess", async () => {
    sessionHolder.current = fakeSession;
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, tonightBody({ preferenceWeights: { price: 60, time: 0, variation: 100, simplicity: 40 } })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await openBlock();

    expect((screen.getByRole("slider", { name: /^Pris/ }) as HTMLInputElement).value).toBe("60");
    expect((screen.getByRole("slider", { name: /^Tid/ }) as HTMLInputElement).value).toBe("0");
    expect((screen.getByRole("slider", { name: /^Variation/ }) as HTMLInputElement).value).toBe("100");
  });

  it("stays off the screen entirely when the response carried no baseline", async () => {
    // A block rendered at zeros would read as the household's own settings and invite
    // a "correction" that writes zeros over whatever is really stored.
    sessionHolder.current = fakeSession;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, suggestionBody));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    expect(screen.queryByRole("button", { name: "Vad är viktigt för er?" })).toBeNull();
  });

  it("saves once when the drag settles — never on every notch", async () => {
    sessionHolder.current = fakeSession;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, tonightBody()));
    vi.stubGlobal("fetch", fetchMock);

    await openBlock();
    const slider = screen.getByRole("slider", { name: /^Pris/ });

    // Four notches dragged past in quick succession — and still one write.
    for (const value of ["5", "10", "15", "20"]) {
      fireEvent.change(slider, { target: { value } });
    }

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => call[1]?.method === "PUT")).toBe(true),
    );
    const writes = fetchMock.mock.calls.filter((call) => call[1]?.method === "PUT");
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toBe("/api/households/preferences");
    expect(JSON.parse(writes[0]![1].body)).toEqual({ price: 20, time: 0, variation: 0, simplicity: 0 });
  });

  it("writes through its own route, never the profile PUT that would wipe it", async () => {
    sessionHolder.current = fakeSession;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, tonightBody()));
    vi.stubGlobal("fetch", fetchMock);

    await openBlock();
    fireEvent.change(screen.getByRole("slider", { name: /^Tid/ }), { target: { value: "25" } });

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => call[1]?.method === "PUT")).toBe(true),
    );
    for (const call of fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")) {
      expect(call[0]).not.toBe("/api/households");
    }
  });

  it("re-ranks once the drag settles, keeping the dish on screen throughout", async () => {
    sessionHolder.current = fakeSession;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, tonightBody()))
      .mockResolvedValue(
        jsonResponse(200, { ...suggestionBodyFor("fisksoppa", "Fisksoppa"), pantryIngredients: PANTRY_OPTIONS, preferenceWeights: NEUTRAL_BASELINE }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await openBlock();
    fireEvent.change(screen.getByRole("slider", { name: /^Pris/ }), { target: { value: "50" } });

    // The dish is still there while the write and the re-rank go out.
    expect(screen.getByRole("heading", { name: "Kycklinggryta" })).toBeTruthy();
    await screen.findByRole("heading", { name: "Fisksoppa" });
  });

  it("changes its hint at a behavioural threshold, not on every notch", async () => {
    sessionHolder.current = fakeSession;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, tonightBody()));
    vi.stubGlobal("fetch", fetchMock);

    await openBlock();
    const slider = screen.getByRole("slider", { name: /^Pris/ });

    expect(screen.getByText("Vi tittar inte på priset när vi väljer.")).toBeTruthy();

    fireEvent.change(slider, { target: { value: "5" } });
    const expressed = "Vi lutar åt billigare middagar, men säsong och omväxling kan väga över.";
    expect(await screen.findByText(expressed)).toBeTruthy();

    // Another notch is a real change in value and no change in claim — which is the
    // whole rule: below one familiarity step, a single notch can be invisible in the
    // ranking, so the copy must not imply otherwise.
    fireEvent.change(slider, { target: { value: "10" } });
    expect(screen.getByText(expressed)).toBeTruthy();

    // 50 is where the axis starts matching a full familiarity step, and that is where
    // the claim is allowed to change.
    fireEvent.change(slider, { target: { value: "50" } });
    expect(
      await screen.findByText("Vi väljer hellre en billigare middag än något ni sällan lagar."),
    ).toBeTruthy();
  });

  it("is the same block, expanded, on the profile — one value on two surfaces", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/households") {
        return jsonResponse(200, { household: { members: [{ type: "adult", portion_factor: 1, allergies: [], dietary_flags: [] }] } });
      }
      return jsonResponse(200, tonightBody({ preferenceWeights: { price: 60, time: 0, variation: 0, simplicity: 0 } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    await user.click(screen.getByRole("link", { name: "Profil" }));

    // Expanded there, with no toggle to open — the household came to adjust things.
    const slider = await screen.findByRole("slider", { name: /^Pris/ });
    expect((slider as HTMLInputElement).value).toBe("60");
    expect(screen.queryByRole("button", { name: "Vad är viktigt för er?" })).toBeNull();
    expect(screen.getAllByRole("slider")).toHaveLength(3);
  });
});
