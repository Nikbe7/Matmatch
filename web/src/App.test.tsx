import type { Session } from "@supabase/supabase-js";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CostTier } from "../../src/schema/ingredient";
import { setAnalyticsSink, type AnalyticsEvent } from "./analytics";
import { saveShoppingList, SHOPPING_LIST_VERSION } from "./shoppingListStorage";
import { saveCookRecord, substitutionKey } from "./instructionsStorage";
import { WEIGHT_ON } from "./refinement";

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
const { costTierLabel } = await import("./App");

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
    template: { id: "kycklinggryta", name: "Kycklinggryta", blurb: "Testblurb för kycklinggryta.", cost_tier: "mid", prep_time_band: "20-40min", effort_level: "simple", cuisine: "swedish_nordic" },
    ingredients: [
      { role: "protein", name: "Kyckling", slotIndex: 0, ingredientId: "kyckling", substituted: false, quantity: { kind: "amount", amount: 400, unit: "g" } },
      { role: "aromatic", name: "Rödlök", slotIndex: 1, ingredientId: "rodlok", substituted: true, quantity: { kind: "amount", amount: 400, unit: "g" } },
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
      template: { id: "kycklinggryta", name: "Kycklinggryta", blurb: "Testblurb för kycklinggryta.", cost_tier: tier, prep_time_band: "20-40min", effort_level: "moderate", cuisine: "swedish_nordic" },
      ingredients: [{ role: "protein", name: "Kyckling", slotIndex: 0, ingredientId: "kyckling", substituted: false, quantity: { kind: "amount", amount: 400, unit: "g" } }],
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

// Onboarding asks who lives here and nothing else. #168's mandatory allergy question
// is gone with allergy filtering (#224), and dietary preferences never belonged here
// — they are ranking influence, edited on the profile. What survives from #168 is the
// shape of the screen: member rows, and a primary action that is not gated on
// anything else.
describe("App — household gate", () => {
  async function renderOnboarding() {
    render(<App />);
    await screen.findByRole("heading", { name: "Vilka bor här?" });
  }

  const submit = () => screen.getByRole("button", { name: "Visa kvällens middag" });

  it("renders onboarding when signed in with no household", async () => {
    sessionHolder.current = fakeSession;
    const fetchMock = vi.fn().mockResolvedValue(householdNotFound);
    vi.stubGlobal("fetch", fetchMock);

    await renderOnboarding();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks for who lives here and nothing else — no preference chips, no constraint chips", async () => {
    sessionHolder.current = fakeSession;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(householdNotFound));

    await renderOnboarding();

    const card = memberCard("Vuxen 1");
    expect(within(card).getByLabelText("Namn")).toBeTruthy();
    expect(within(card).getByLabelText("Typ")).toBeTruthy();
    expect(within(card).getByLabelText("Portionsstorlek")).toBeTruthy();
    // Dietary preferences are edited on the profile, and there is no allergy question
    // any more (#224) — the screen asks nothing but who lives here.
    expect(card.querySelector("fieldset")).toBeNull();
    expect(screen.queryByRole("button", { name: "Vegetariskt" })).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("creates a valid household with an explicitly empty dietary_flags list", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(householdNotFound)
      .mockResolvedValueOnce(jsonResponse(201, { id: "h1", members: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { result: null, reason: "no_safe_templates" }));
    vi.stubGlobal("fetch", fetchMock);

    await renderOnboarding();
    await user.click(submit());

    await screen.findByRole("heading", { name: "Ikväll" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/households");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST" });

    // Explicitly empty, never omitted: an unset constraint must not be mistakable for
    // a declared-empty one (HouseholdMemberSchema, and the not-null column behind it).
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.members).toHaveLength(1);
    expect(body.members[0].dietary_flags).toEqual([]);
    expect("dietary_flags" in body.members[0]).toBe(true);
    expect("allergies" in body.members[0]).toBe(false);
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

describe("costTierLabel", () => {
  // "Mellan" was the "mid" cost tier's old label — and also EFFORT_LEVEL_LABELS'
  // word for "moderate" effort, so the two could read identically on screen with
  // nothing to tell them apart. Explicitly price words (2026-08-23) fix that.
  const expected: Record<CostTier, string> = {
    budget: "Billigt",
    mid: "Mellanpris",
    premium: "Dyrare",
  };

  for (const [tier, label] of Object.entries(expected) as [CostTier, string][]) {
    it(`maps "${tier}" to its Swedish price label`, () => {
      expect(costTierLabel(tier)).toBe(label);
    });
  }
});

describe("App — Tonight suggestion card", () => {
  it("renders the dish name, cost tier label and prep time — and no ingredient list", async () => {
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

    // The raw "mid" enum value must never leak into rendered text — only its
    // Swedish price label should appear. No dot meter any more (2026-08-23): the
    // word is the only carrier, and it's plain visible text, not an aria-label-only
    // announcement.
    expect(container.textContent).not.toMatch(/\bmid\b/);
    expect(container.textContent).toContain("Mellanpris");

    // #151/#161: effort_level renders as a Swedish word beside the cost tier, not
    // as a raw enum value and not as a dot meter — the row is plain text throughout.
    expect(container.textContent).not.toMatch(/\bsimple\b/);
    const metaRow = container.querySelector(".suggestion__meta")!;
    expect(metaRow.textContent).toContain("Enkelt");
    expect(within(metaRow as HTMLElement).queryAllByRole("img")).toHaveLength(0);
  });

  it("shows one reason only, phrased as a sentence with no numbers, even when the server sends two", async () => {
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

    // #185: the engine sent two codes; the card renders the strongest and stops. A
    // second "och" clause wrapped the line onto a second row, which is what set it
    // apart from the reference's single quiet sentence.
    const reason = screen.getByText(/^Valt för att/);
    expect(reason.textContent).toBe("Valt för att den är i säsong.");
    expect(reason.textContent).not.toContain(" och ");
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

  const labelByTier: Record<CostTier, string> = {
    budget: "Billigt",
    mid: "Mellanpris",
    premium: "Dyrare",
  };

  for (const [tier, label] of Object.entries(labelByTier) as [CostTier, string][]) {
    it(`renders "${label}" as the visible cost tier label for "${tier}"`, async () => {
      sessionHolder.current = fakeSession;
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, suggestionBodyForTier(tier))));

      render(<App />);
      await screen.findByRole("heading", { name: "Kycklinggryta" });

      // A bare text node inside `.suggestion__meta`, not its own element — `getByText`
      // can't match it, so check the meta row's combined text instead.
      expect(document.querySelector(".suggestion__meta")!.textContent).toContain(label);
    });
  }
});

function suggestionBodyFor(id: string, name: string, cuisine = "swedish_nordic") {
  return {
    result: {
      template: { id, name, blurb: `Testblurb för ${name.toLowerCase()}.`, cost_tier: "budget", prep_time_band: "<20min", effort_level: "moderate", cuisine },
      ingredients: [{ role: "protein", name: "Torsk", slotIndex: 0, ingredientId: "torsk", substituted: false, quantity: { kind: "amount", amount: 400, unit: "g" } }],
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

  it("turns the price weight on at full strength and keeps the chip pressed", async () => {
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

    expect(screen.getByRole("button", { name: "Billigare" }).getAttribute("aria-pressed")).toBe("false");

    await user.click(screen.getByRole("button", { name: "Billigare" }));
    await screen.findByRole("heading", { name: "Linssoppa" });
    expect((fetchMock.mock.calls[1]![0] as string)).toContain(`price=${WEIGHT_ON}`);

    // Still pressed a reroll later — the whole point of chip state being
    // session-persistent rather than per-request.
    const pressed = screen.getByRole("button", { name: "Billigare" });
    expect(pressed.getAttribute("aria-pressed")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Byt förslag" }));
    await screen.findByRole("heading", { name: "Ärtsoppa" });
    expect(screen.getByRole("button", { name: "Billigare" }).getAttribute("aria-pressed")).toBe("true");
    expect((fetchMock.mock.calls[2]![0] as string)).toContain(`price=${WEIGHT_ON}`);
  });

  it("a second tap turns the axis back off, and still requests a new suggestion", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: string) =>
      jsonResponse(200, suggestionBodyFor(`dish-${url.length}`, `Dish ${url.length}`)),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, suggestionBody));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "Snabbare" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Snabbare" }).getAttribute("aria-pressed")).toBe("true"),
    );

    const callsWhileOn = fetchMock.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Snabbare" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Snabbare" }).getAttribute("aria-pressed")).toBe("false"),
    );
    // Turning the chip off is not a no-op — it re-requests like every other tap.
    expect(fetchMock.mock.calls.length).toBe(callsWhileOn + 1);
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

    await user.click(screen.getByRole("button", { name: "Billigare" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Billigare" }).getAttribute("aria-pressed")).toBe("true"),
    );

    await user.click(screen.getByRole("button", { name: "Återställ" }));
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    const restored = screen.getByRole("button", { name: "Billigare" });
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

    await user.click(screen.getByRole("button", { name: "Snabbare" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Snabbare" }).getAttribute("aria-pressed")).toBe("true"),
    );
    expect(screen.getByRole("button", { name: "Återställ" })).toBeTruthy();

    // And gone again once the session is back to neutral, rather than lingering as
    // the one chip that never turns off.
    await user.click(screen.getByRole("button", { name: "Återställ" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Snabbare" }).getAttribute("aria-pressed")).toBe("false"),
    );
    expect(screen.queryByRole("button", { name: "Återställ" })).toBeNull();
  });

  it("keeps Återställ away after rerolls — a reroll is not a setting (#185)", async () => {
    // "Byt förslag" is its own undo: the next tap replaces what the last one showed.
    // Letting Återställ appear for it would make the chip mean two different things —
    // "put the adjustments back" and "forget the dishes you turned down" — and the
    // household would have no way to tell which one they were about to get.
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, suggestionBody))
        .mockResolvedValueOnce(jsonResponse(200, suggestionBodyFor("linssoppa", "Linssoppa")))
        .mockResolvedValueOnce(jsonResponse(200, suggestionBodyFor("fisksoppa", "Fisksoppa"))),
    );

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "Byt förslag" }));
    await screen.findByRole("heading", { name: "Linssoppa" });
    await user.click(screen.getByRole("button", { name: "Byt förslag" }));
    await screen.findByRole("heading", { name: "Fisksoppa" });

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

    await user.click(screen.getByRole("button", { name: "Testa nytt" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Testa nytt" }).getAttribute("aria-pressed")).toBe("true"),
    );

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

    await user.click(screen.getByRole("button", { name: "Billigare" }));
    await screen.findByRole("heading", { name: "Linssoppa" });
    await user.click(screen.getByRole("button", { name: "Byt förslag" }));
    await screen.findByRole("heading", { name: "Ärtsoppa" });

    expect(events).toEqual([
      {
        name: "refinement_chip_tap",
        chip: "cheaper",
        weights: { price: WEIGHT_ON, time: 0, variation: 0, simplicity: 0 },
        level: 1,
        rerollDepth: 1,
      },
      {
        name: "refinement_chip_tap",
        chip: "something_else",
        weights: { price: WEIGHT_ON, time: 0, variation: 0, simplicity: 0 },
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
        items: [{ name: "Svarta bönor", section: "to_buy", bought: false, quantity: { kind: "amount", amount: 400, unit: "g" }, slotIndex: 0, ingredientId: "svarta-bonor" }],
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
        items: [{ name: "Kyckling", section: "to_buy", bought: false, quantity: { kind: "amount", amount: 400, unit: "g" }, slotIndex: 0, ingredientId: "kyckling" }],
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
          { name: "Kyckling", section: "to_buy", bought: false, quantity: { kind: "amount", amount: 400, unit: "g" }, slotIndex: 0, ingredientId: "kyckling" },
          { name: "Ris", section: "have_at_home", bought: false, quantity: { kind: "amount", amount: 400, unit: "g" }, slotIndex: 1, ingredientId: "ris" },
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
        items: [{ name: "Kyckling", section: "to_buy", bought: false, quantity: { kind: "amount", amount: 400, unit: "g" }, slotIndex: 0, ingredientId: "kyckling" }],
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
          effort_level: "moderate",
          cuisine: "swedish_nordic",
        },
        ingredients: [{ role: "protein", name: "Kyckling", slotIndex: 0, ingredientId: "kyckling", substituted: false, quantity: { kind: "amount", amount: 400, unit: "g" } }],
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

  it("says nothing about allergens — the picker scopes dietary flags and portions only", async () => {
    // Inverts the pre-#224 assertion. The cross-contamination caveat this screen used
    // to carry was honest while the app filtered allergens; with nothing else in the
    // product mentioning them, it reads as a residual promise instead of a limit.
    sessionHolder.current = fakeSession;
    stubTonight(suggestionWithDiners("kycklinggryta"));

    render(<App />);

    await screen.findByRole("heading", { name: "kycklinggryta" });
    const picker = screen.getByRole("group", { name: "Vilka äter?" });
    expect(picker.textContent).not.toMatch(/allergen/i);
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
          effort_level: "moderate",
          cuisine: "swedish_nordic",
        },
        ingredients: [
          {
            role: "protein",
            name: "Kyckling",
            slotIndex: 0,
            ingredientId: "kyckling",
            substituted: false,
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
              effort_level: "moderate",
              cuisine: "swedish_nordic",
            },
            ingredients: [{ role: "protein", name: "Kyckling", slotIndex: 0, ingredientId: "kyckling", substituted: false, quantity: { kind: "amount", amount: 400, unit: "g" } }],
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

    // One group, not two: the allergy fieldset beside this one is gone with allergy
    // filtering (#224), and nothing on this screen is a safety constraint any more —
    // which is why there is no warning glyph or `allergy-group` class left to assert.
    const groups = Array.from(document.querySelectorAll(".profile-member-detail fieldset"));
    expect(groups).toHaveLength(1);

    const [preferences] = groups as [HTMLFieldSetElement];
    expect(preferences.querySelector("legend")!.textContent).toBe("Kostpreferenser");
    expect(document.querySelector(".allergy-group")).toBeNull();

    expect(Array.from(preferences.querySelectorAll("button")).map((b) => b.textContent)).toEqual([
      "Vegetariskt",
      "Veganskt",
      "Proteinrikt",
    ]);
  });

  it("keeps the collapsed row to name and type — it summarises no constraint", async () => {
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

    // The allergy names this line used to carry were its only constraint content, and
    // they went with allergy filtering (#224). Nothing replaced them: a member's
    // dietary flags are visible once the row is expanded and not before. Pinned rather
    // than left implicit, because "the row shows no constraint at all" is a product
    // consequence of #224 someone should decide about deliberately, not discover.
    const row = await screen.findByRole("button", { name: /^Ella/ });
    expect(row.textContent).toContain("Ella");
    expect(row.textContent).toContain("Barn");

    await user.click(row);
    await user.click(screen.getByRole("button", { name: "Vegetariskt" }));

    expect(screen.getByRole("button", { name: /^Ella/ }).textContent).not.toContain("Vegetariskt");
    // The chip itself does hold the state — it is the summary line that stays silent.
    expect(screen.getByRole("button", { name: "Vegetariskt" }).getAttribute("aria-pressed")).toBe(
      "true",
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
    await user.click(screen.getByRole("button", { name: "Vegetariskt" }));
    await user.click(screen.getByRole("button", { name: "Spara" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    // The edit survives the failed save — retrying does not mean re-selecting it.
    expect(screen.getByRole("button", { name: "Vegetariskt" }).getAttribute("aria-pressed")).toBe(
      "true",
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

// One of its ingredients ("ris") also names a pantry-row option, so tapping that
// chip and choosing this dish is the case #200 covers.
function risDishBody() {
  return {
    result: {
      template: { id: "risgryta", name: "Risgryta", blurb: "Testblurb.", cost_tier: "budget", prep_time_band: "<20min", effort_level: "simple", cuisine: "swedish_nordic" },
      ingredients: [
        { role: "starch", name: "Ris", slotIndex: 0, ingredientId: "ris", substituted: false, quantity: { kind: "amount", amount: 300, unit: "g" } },
        { role: "protein", name: "Kyckling", slotIndex: 1, ingredientId: "kyckling", substituted: false, quantity: { kind: "amount", amount: 400, unit: "g" } },
      ],
      substitutions: [],
      score: 0.4,
      cookedToday: false,
    },
    portions: 2,
    pantryIngredients: PANTRY_OPTIONS,
    preferenceWeights: NEUTRAL_BASELINE,
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

  // #206/#201: the "Fler" layer — the longest list in the app, and until now the one
  // with no way to narrow it and a tab bar painted on top of it.
  it("narrows the sheet's list as you type, and falls back to the whole list on a miss", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, tonightBody())));

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });
    await user.click(screen.getByRole("button", { name: "Fler" }));

    const sheet = screen.getByRole("dialog", { name: "Vad har du hemma?" });
    const filter = within(sheet).getByRole("textbox");

    await user.type(filter, "purjo");
    expect(within(sheet).getByRole("button", { name: "purjolök" })).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "ris" })).toBeNull();

    // A miss shows the full list under an explanation rather than an empty grid —
    // the same fallback step 2's own filter makes (#110).
    await user.clear(filter);
    await user.type(filter, "zzzz");
    expect(within(sheet).getByRole("status").textContent).toContain("Ingen träff");
    expect(within(sheet).getByRole("button", { name: "purjolök" })).toBeTruthy();
  });

  it("makes the bottom nav inert while the sheet is open, and interactive again after", async () => {
    // Raising the z-index alone was not enough (#201): a nav painted behind a sheet
    // is still in the tab order and still reachable by a screen reader, and the
    // dialog claims aria-modal="true".
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, tonightBody())));

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    const nav = screen.getByRole("navigation", { name: "Huvudnavigation" });
    expect(nav.hasAttribute("inert")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Fler" }));
    expect(nav.hasAttribute("inert")).toBe(true);

    const sheet = screen.getByRole("dialog", { name: "Vad har du hemma?" });
    await user.click(within(sheet).getByRole("button", { name: "Klar" }));
    expect(nav.hasAttribute("inert")).toBe(false);
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

    expect(screen.getByText("Valt för att ni har spagetti och gul lök hemma.")).toBeTruthy();
  });

  it("lets the pantry reason take the line even when the engine ranked another first", async () => {
    // #185: it is the only reason naming something the household told us one tap ago,
    // so it is the one they can actually check.
    sessionHolder.current = fakeSession;
    const body = tonightBody();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          ...body,
          result: {
            ...body.result,
            reasonCodes: ["in_season", "pantry_match"],
            pantryMatch: ["potatis"],
          },
        }),
      ),
    );

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    const reason = screen.getByText(/^Valt för att/);
    expect(reason.textContent).toBe("Valt för att ni har potatis hemma.");
    expect(reason.textContent).not.toContain("säsong");
  });

  it("seeds 'Har hemma' on the shopping list from what was marked on Tonight's pantry row (#200)", async () => {
    // Before #200: the dish's own reason line could say "ni har ris hemma" while the
    // resulting list put ris under "Behöver handlas" like every other item — the one
    // input this zero-input screen asks for was thrown away exactly where it should
    // have paid off.
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, tonightBody()))
      .mockResolvedValue(jsonResponse(200, risDishBody()));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "ris" }));
    await screen.findByRole("heading", { name: "Risgryta" });

    await user.click(screen.getByRole("button", { name: "Laga ikväll" }));

    await screen.findByRole("heading", { name: "Behöver handlas (1)" });
    expect(screen.getByText("Kyckling")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Har hemma (1)" })).toBeTruthy();
    expect(screen.getByText("Ris")).toBeTruthy();
  });

  it("applies a pantry tap even when a list was already stored from an earlier accept of the same dish (#200)", async () => {
    // The bare fix alone has a gap: ShoppingList's own useState initializer prefers
    // a stored list for the same template id over anything freshly computed. A
    // household that accepts a dish once (no pantry tap), backs out with "Nytt
    // förslag", marks a pantry item, and accepts the *same* dish again must not have
    // that second tap silently swallowed by the first accept's already-stored list.
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, risDishBody()));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Risgryta" });

    // First accept, no pantry tap — stores ris and kyckling both under "to_buy".
    await user.click(screen.getByRole("button", { name: "Laga ikväll" }));
    await screen.findByRole("heading", { name: "Behöver handlas (2)" });

    // Back to Ikväll without a reload — Gate's fetch never reruns, so the same
    // dish is still on screen.
    await user.click(screen.getByRole("button", { name: "Nytt förslag" }));
    await screen.findByRole("heading", { name: "Risgryta" });

    await user.click(screen.getByRole("button", { name: "ris" }));
    await user.click(screen.getByRole("button", { name: "Laga ikväll" }));

    await screen.findByRole("heading", { name: "Behöver handlas (1)" });
    expect(screen.getByText("Kyckling")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Har hemma (1)" })).toBeTruthy();
    expect(screen.getByText("Ris")).toBeTruthy();
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
    expect(fetchMock.mock.calls[1]![0] as string).toContain(`variation=${WEIGHT_ON}`);
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
    expect(Number(viaChip)).toBe(WEIGHT_ON);
  });

});

describe("App — Enklare (#153, #151)", () => {
  it("moves the simplicity axis in the same notches the other chips use", async () => {
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

    await user.click(screen.getByRole("button", { name: /^Enklare/ }));

    await screen.findByRole("heading", { name: "Fisksoppa" });
    expect(fetchMock.mock.calls[1]![0] as string).toContain(`simplicity=${WEIGHT_ON}`);
  });

  it("expresses itself on the same axis the Enkelhet slider does — same value, either way in", async () => {
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

    await user.click(screen.getByRole("button", { name: /^Enklare/ }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
    const viaChip = new URL(fetchMock.mock.calls[1]![0] as string, "http://x").searchParams.get(
      "simplicity",
    );

    await user.click(screen.getByRole("button", { name: "Vad är viktigt för er?" }));
    const slider = screen.getByRole("slider", { name: /^Enkelhet/ });
    expect(slider.getAttribute("max")).toBe("100");
    expect(slider.getAttribute("step")).toBe("5");
    expect(Number(viaChip)).toBe(WEIGHT_ON);
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

  it("renders exactly four sliders, enkelhet included, in the same register as the rest", async () => {
    sessionHolder.current = fakeSession;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, tonightBody()));
    vi.stubGlobal("fetch", fetchMock);

    await openBlock();

    expect(screen.getAllByRole("slider")).toHaveLength(4);
    expect(screen.getByRole("slider", { name: /^Pris/ })).toBeTruthy();
    expect(screen.getByRole("slider", { name: /^Tid/ })).toBeTruthy();
    expect(screen.getByRole("slider", { name: /^Variation/ })).toBeTruthy();
    expect(screen.getByRole("slider", { name: /^Enkelhet/ })).toBeTruthy();
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

    // Three notches dragged past — the native `input` event, same as a real drag —
    // and only the release (`change`) commits.
    for (const value of ["5", "10", "15"]) {
      fireEvent.input(slider, { target: { value } });
    }
    fireEvent.change(slider, { target: { value: "20" } });

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

  it("shows no separate value label — the hint is the only summary of a notch, for sighted and screen-reader households alike", async () => {
    // The bug this replaces: a value label ("Spelar ingen roll") beside the axis name
    // that could say the opposite of the hint sentence right under it (Variation and
    // Enkelhet at notch 0, where the hint describes real engine behaviour rather than
    // "no effect"). One summary now, not two, and the accessible layer carries the
    // same one the household reads rather than a competing word.
    sessionHolder.current = fakeSession;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, tonightBody()));
    vi.stubGlobal("fetch", fetchMock);

    await openBlock();

    for (const text of ["Spelar ingen roll", "Spelar viss roll", "Spelar stor roll", "Spelar störst roll"]) {
      expect(screen.queryByText(text)).toBeNull();
    }

    const variationSlider = screen.getByRole("slider", { name: /^Variation/ });
    const enkelhetSlider = screen.getByRole("slider", { name: /^Enkelhet/ });
    expect(variationSlider.getAttribute("aria-valuetext")).toBe(
      "Vi håller oss till sådant ni känner igen.",
    );
    expect(enkelhetSlider.getAttribute("aria-valuetext")).toBe(
      "Det får gärna kräva lite pyssel i köket.",
    );

    fireEvent.change(variationSlider, { target: { value: "100" } });
    await waitFor(() =>
      expect(variationSlider.getAttribute("aria-valuetext")).toBe(
        "Nya rätter får samma chans som era vanliga.",
      ),
    );
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
    expect(screen.getAllByRole("slider")).toHaveLength(4);
  });
});
