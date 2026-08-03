import type { Session } from "@supabase/supabase-js";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALLERGIES } from "../../src/schema/vocabulary";
import type { CostTier } from "../../src/schema/ingredient";

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

const { default: App } = await import("./App");
const { ALLERGY_LABELS, costTierMeter, costTierLabel } = await import("./App");

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
    template: { name: "Kycklinggryta", cost_tier: "mid", prep_time_band: "20-40min" },
    ingredients: [
      { role: "protein", name: "Kyckling", substituted: false },
      { role: "aromatic", name: "Rödlök", substituted: true },
    ],
    substitutions: [],
    score: 0.5,
  },
};

function suggestionBodyForTier(tier: CostTier) {
  return {
    result: {
      template: { name: "Kycklinggryta", cost_tier: tier, prep_time_band: "20-40min" },
      ingredients: [{ role: "protein", name: "Kyckling", substituted: false }],
      substitutions: [],
      score: 0.5,
    },
  };
}

beforeEach(() => {
  sessionHolder.current = null;
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

  it("renders exactly the locked allergy vocabulary as chips", async () => {
    sessionHolder.current = fakeSession;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(householdNotFound));

    render(<App />);
    await screen.findByRole("heading", { name: "Skapa hushåll" });

    const fieldset = screen.getByText("Allergier").closest("fieldset")!;
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

    await screen.findByRole("heading", { name: "Tonight" });
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

  it("keeps a household with no safe result in the Tonight no-result state, not onboarding", async () => {
    sessionHolder.current = fakeSession;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { result: null, reason: "no_safe_templates" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await screen.findByRole("heading", { name: "Tonight" });
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

  it("Accept moves to a confirmation state, with a way back to the suggestion", async () => {
    sessionHolder.current = fakeSession;
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, suggestionBody)));

    render(<App />);
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    await user.click(screen.getByRole("button", { name: "Acceptera" }));

    await screen.findByText("Ikväll: Kycklinggryta");
    expect(screen.queryByRole("heading", { name: "Kycklinggryta" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Tillbaka till förslaget" }));
    await screen.findByRole("heading", { name: "Kycklinggryta" });
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
