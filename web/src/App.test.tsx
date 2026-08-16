import type { Session } from "@supabase/supabase-js";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALLERGIES } from "../../src/schema/vocabulary";
import type { CostTier } from "../../src/schema/ingredient";
import { setAnalyticsSink, type AnalyticsEvent } from "./analytics";

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

vi.mock("./supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: sessionHolder.current } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: () => Promise.resolve({ error: null }),
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App — signed out", () => {
  it("renders the login form and never reaches the network", async () => {
    render(<App />);
    await screen.findByText("Sign in");
    expect(screen.getByRole("textbox", { name: "Email" })).toBeTruthy();
  });
});

describe("App — household gate", () => {
  it("renders onboarding when signed in with no household", async () => {
    sessionHolder.current = fakeSession;
    const fetchMock = vi.fn().mockResolvedValue(householdNotFound);
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await screen.findByRole("heading", { name: "Skapa hushåll" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders exactly the locked allergy vocabulary as chips, per member", async () => {
    sessionHolder.current = fakeSession;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(householdNotFound));

    render(<App />);
    await screen.findByRole("heading", { name: "Skapa hushåll" });

    const fieldset = memberCard("Vuxen 1").querySelector("fieldset.allergy-group")!;
    const chipLabels = Array.from(fieldset.querySelectorAll("button")).map(
      (button) => button.textContent,
    );

    expect(chipLabels).toEqual(ALLERGIES.map((allergy) => ALLERGY_LABELS[allergy]));
  });

  it("submitting a valid household calls the API and switches to Tonight", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(householdNotFound)
      .mockResolvedValueOnce(
        jsonResponse(201, { id: "h1", members: [], allergies: [], dietary_flags: [] }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { result: null, reason: "no_safe_templates" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Skapa hushåll" });

    await user.click(screen.getByRole("button", { name: "Spara hushåll" }));

    await screen.findByRole("heading", { name: "Ikväll" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/households");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST" });
  });

  it("keeps the form filled and shows a readable message on API error", async () => {
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

    render(<App />);
    await screen.findByRole("heading", { name: "Skapa hushåll" });

    await user.click(screen.getByRole("button", { name: "Lägg till medlem" }));
    expect(screen.getAllByText("Typ")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Spara hushåll" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("members must contain at least 1 element(s)");
    expect(alert.textContent).not.toContain("{");
    expect(screen.getAllByText("Typ")).toHaveLength(2);
  });

  it("sends each member's own allergies and dietary flags, not one household-wide set", async () => {
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

    render(<App />);
    await screen.findByRole("heading", { name: "Skapa hushåll" });

    // Member 1 is peanut-allergic; member 2 is vegetarian and allergic to nothing.
    await user.click(within(memberCard("Vuxen 1")).getByRole("button", { name: "Jordnötter" }));
    await user.click(screen.getByRole("button", { name: "Lägg till medlem" }));
    await user.click(within(memberCard("Vuxen 2")).getByRole("button", { name: "Vegetariskt" }));

    await user.click(screen.getByRole("button", { name: "Spara hushåll" }));
    await screen.findByRole("heading", { name: "Ikväll" });

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.members).toHaveLength(2);
    expect(body.members[0]).toMatchObject({ allergies: ["peanuts"], dietary_flags: [] });
    expect(body.members[1]).toMatchObject({ allergies: [], dietary_flags: ["vegetarian"] });
    // The household itself no longer carries either field.
    expect(body.allergies).toBeUndefined();
    expect(body.dietary_flags).toBeUndefined();
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

    render(<App />);
    await screen.findByRole("heading", { name: "Skapa hushåll" });
    await user.click(screen.getByRole("button", { name: "Spara hushåll" }));
    await screen.findByRole("heading", { name: "Ikväll" });

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect("name" in body.members[0]).toBe(false);
  });

  it("labels unnamed members by type and ordinal, and swaps in a name once given", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(householdNotFound));

    render(<App />);
    await screen.findByRole("heading", { name: "Skapa hushåll" });

    expect(screen.getByRole("heading", { name: "Vuxen 1" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Lägg till medlem" }));
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

  it("keeps allergies in their own labelled group, distinguishable from preferences by more than colour", async () => {
    // #101/UX_FLOW §6, re-asserted at the per-member scale: moving constraints into
    // member rows is exactly where the two chip groups would get flattened into one.
    sessionHolder.current = fakeSession;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(householdNotFound));

    render(<App />);
    await screen.findByRole("heading", { name: "Skapa hushåll" });

    const card = memberCard("Vuxen 1");
    const groups = Array.from(card.querySelectorAll("fieldset"));
    expect(groups).toHaveLength(2);

    const [preferences, allergies] = groups as [HTMLFieldSetElement, HTMLFieldSetElement];
    expect(preferences.querySelector("legend")!.textContent).toBe("Kostpreferenser");
    // Distinct legend text plus a warning glyph — both non-colour signals, present in
    // the markup rather than only in the stylesheet.
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

  it("keeps a household with no safe result in the Tonight no-result state, not onboarding", async () => {
    sessionHolder.current = fakeSession;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { result: null, reason: "no_safe_templates" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await screen.findByRole("heading", { name: "Ikväll" });
    expect(screen.getByText(/no result: no_safe_templates/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Skapa hushåll" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
  it("renders the dish name, cost tier meter, prep time, and the substituted ingredient's name", async () => {
    sessionHolder.current = fakeSession;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, suggestionBody)));

    const { container } = render(<App />);

    await screen.findByRole("heading", { name: "Kycklinggryta" });
    expect(screen.getByText(/20–40 min/)).toBeTruthy();
    expect(screen.getByText("Testblurb för kycklinggryta.")).toBeTruthy();
    expect(screen.getByText("Protein: Kyckling")).toBeTruthy();
    expect(screen.getByText(/Rödlök/)).toBeTruthy();
    expect(screen.getByText(/\(ersättning\)/)).toBeTruthy();

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

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    expect(screen.queryByText(/^Valt för att/)).toBeNull();
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

  it("raises the cost weight, keeps the chip pressed, and announces its level", async () => {
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
    expect((fetchMock.mock.calls[1]![0] as string)).toContain("cost=1");

    // Still pressed and still showing its level a reroll later — the whole point
    // of chip state being session-persistent rather than per-request.
    const pressed = screen.getByRole("button", { name: "Billigare, nivå 1 av 2" });
    expect(pressed.getAttribute("aria-pressed")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Byt förslag" }));
    await screen.findByRole("heading", { name: "Ärtsoppa" });
    expect(screen.getByRole("button", { name: "Billigare, nivå 1 av 2" })).toBeTruthy();
    expect((fetchMock.mock.calls[2]![0] as string)).toContain("cost=1");
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
    await screen.findByText("Du har sett allt vi har för ikväll");
    expect(screen.queryByRole("heading", { name: "Kycklinggryta" })).toBeNull();
    // Recoverable, not an error and not a blank card.
    expect(screen.queryByRole("alert")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Återställ" }));
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    // Reset re-requests with no exclusions and no weights at all.
    const resetUrl = fetchMock.mock.calls[2]![0] as string;
    expect(resetUrl).not.toContain("exclude=");
    expect(resetUrl).not.toContain("cost=");
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
        weights: { cost: 1, time: 0 },
        level: 1,
        rerollDepth: 1,
      },
      {
        name: "refinement_chip_tap",
        chip: "something_else",
        weights: { cost: 1, time: 0 },
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

describe("App — entering the guided flow", () => {
  it("opens the guided flow from the Tonight card and comes back", async () => {
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

    await user.click(screen.getByRole("button", { name: "Bygg en middag" }));
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

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("Ingen anslutning. Anslut till internet för att komma igång.");
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
    expect(screen.getByRole("alert").textContent).toContain("network down");

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
    await screen.findByRole("heading", { name: "Skapa hushåll" });

    expect(screen.queryByRole("navigation", { name: "Huvudnavigation" })).toBeNull();
  });
});
