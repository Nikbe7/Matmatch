import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuidedFlow } from "./GuidedFlow";
import type { StoredShoppingList } from "./shoppingListStorage";

// Renders the guided flow (UX_FLOW §5) against a stubbed API. The step machine
// itself is covered directly in guided.test.ts; what this file proves is the
// wiring — that each step renders taps rather than text inputs, that the request
// carries what the household selected, that the §9 empty state offers a way out,
// and that nothing about the pantry reaches localStorage.

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const options = {
  mainIngredients: [
    { id: "kycklingfile", name: "kycklingfilé" },
    { id: "svarta-bonor", name: "svarta bönor" },
  ],
  pantryIngredients: [
    { id: "ris", name: "ris" },
    { id: "gul-lok", name: "gul lök" },
  ],
};

function direction(id: string, name: string, costTier = "mid") {
  return {
    template: {
      id,
      name,
      cost_tier: costTier,
      prep_time_band: "20-40min",
      cuisine: "swedish_nordic",
    },
    ingredients: [
      { role: "protein", name: "Kycklingfilé", substituted: false, inPantry: false },
      { role: "starch", name: "Ris", substituted: false, inPantry: true },
    ],
    substitutions: [],
    summary: "Kycklingfilé, ris och paprika",
    score: 1,
  };
}

const threeDirections = {
  directions: [
    direction("gryta", "Kycklinggryta"),
    direction("wok", "Kycklingwok"),
    direction("pasta", "Kycklingpasta"),
  ],
  mainIngredientId: "kycklingfile",
  portions: 2,
};

const noDirections = {
  directions: [],
  reason: "no_directions",
  mainIngredientId: "kycklingfile",
  portions: 2,
};

/** Answers `/api/guided/options` once, then every directions request with `body`. */
function stubApi(body: unknown = threeDirections) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.startsWith("/api/guided/options")) return jsonResponse(200, options);
    if (url.startsWith("/api/guided/directions")) return jsonResponse(200, body);
    // Instructions, fetched by the shopping list — irrelevant here but must not 404
    // the test into an error path.
    return jsonResponse(200, { instructions: null, reason: "not_configured" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function directionsQueries(fetchMock: ReturnType<typeof vi.fn>): URLSearchParams[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.startsWith("/api/guided/directions"))
    .map((url) => new URLSearchParams(url.split("?")[1]));
}

function renderFlow(onExit = vi.fn(), resume?: StoredShoppingList) {
  render(<GuidedFlow accessToken="token-123" onExit={onExit} resume={resume} />);
  return onExit;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GuidedFlow — the happy path, tap by tap", () => {
  it("walks intent → ingredient → pantry → cards → portions → shopping list", async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi();
    renderFlow();

    await screen.findByRole("heading", { name: "Vad är du sugen på?" });
    await user.click(screen.getByRole("button", { name: "Middagsidé" }));

    await screen.findByRole("heading", { name: "Vilken huvudingrediens?" });
    await user.click(await screen.findByRole("button", { name: "kycklingfilé" }));

    await screen.findByRole("heading", { name: "Vad har du hemma?" });
    await user.click(screen.getByRole("button", { name: "ris" }));
    await user.click(screen.getByRole("button", { name: "Visa förslag" }));

    await screen.findByRole("heading", { name: "Tre förslag" });
    expect(screen.getByRole("heading", { name: "Kycklinggryta" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Välj" })).toHaveLength(3);

    await user.click(screen.getAllByRole("button", { name: "Välj" })[0]!);

    await screen.findByRole("heading", { name: "Hur många portioner?" });
    expect(screen.getByRole("status").textContent).toBe("För 2 portioner");

    await user.click(screen.getByRole("button", { name: "Till inköpslistan" }));

    await screen.findByRole("heading", { name: "Kycklinggryta", level: 2 });
    expect(screen.getByText("Att köpa (1)")).toBeTruthy();
    // The pantry selection carries through: the ingredient the household said it
    // has starts in "Har hemma" rather than on the shopping list.
    expect(screen.getByText("Har hemma (1)")).toBeTruthy();

    const [query] = directionsQueries(fetchMock);
    expect(query!.get("intent")).toBe("dinner_idea");
    expect(query!.get("main")).toBe("kycklingfile");
    expect(query!.get("pantry")).toBe("ris");
  });

  it("shows three cards with a cost meter that is a tier, never a price", async () => {
    const user = userEvent.setup();
    stubApi({
      ...threeDirections,
      directions: [
        direction("a", "Budgetgryta", "budget"),
        direction("b", "Mellangryta", "mid"),
        direction("c", "Lyxgryta", "premium"),
      ],
    });
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Överraska mig" }));
    await screen.findByRole("heading", { name: "Tre förslag" });

    expect(screen.getByRole("img", { name: "Billig" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Mellan" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Dyr" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\d+\s*kr/i);
  });

  it("shows the one-line description on every card", async () => {
    const user = userEvent.setup();
    stubApi();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Överraska mig" }));

    expect(await screen.findAllByText("Kycklingfilé, ris och paprika")).toHaveLength(3);
  });

  it("names the pantry ingredients a dish already covers", async () => {
    const user = userEvent.setup();
    stubApi();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Använd det jag har" }));
    await user.click(await screen.findByRole("button", { name: "kycklingfilé" }));
    await user.click(await screen.findByRole("button", { name: "ris" }));
    await user.click(screen.getByRole("button", { name: "Visa förslag" }));

    expect((await screen.findAllByText(/Du har redan: Ris/))[0]).toBeTruthy();
  });
});

describe("GuidedFlow — no typing anywhere (UX_FLOW §1/§2)", () => {
  it("renders no text input or search box on any step", async () => {
    const user = userEvent.setup();
    stubApi();
    renderFlow();

    const assertNoTextEntry = () => {
      expect(screen.queryAllByRole("textbox")).toEqual([]);
      expect(screen.queryAllByRole("searchbox")).toEqual([]);
      expect(document.querySelectorAll("input[type=text], input[type=search]")).toHaveLength(0);
    };

    await screen.findByRole("heading", { name: "Vad är du sugen på?" });
    assertNoTextEntry();

    await user.click(screen.getByRole("button", { name: "Middagsidé" }));
    await screen.findByRole("heading", { name: "Vilken huvudingrediens?" });
    assertNoTextEntry();

    await user.click(await screen.findByRole("button", { name: "kycklingfilé" }));
    await screen.findByRole("heading", { name: "Vad har du hemma?" });
    assertNoTextEntry();

    await user.click(screen.getByRole("button", { name: "Hoppa över" }));
    await screen.findByRole("heading", { name: "Tre förslag" });
    assertNoTextEntry();
  });
});

describe("GuidedFlow — 'Föreslå åt mig' and 'Överraska mig'", () => {
  it("asks the engine to pick the main ingredient", async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Middagsidé" }));
    await user.click(await screen.findByRole("button", { name: "Föreslå åt mig" }));
    await user.click(await screen.findByRole("button", { name: "Hoppa över" }));

    await screen.findByRole("heading", { name: "Tre förslag" });
    expect(directionsQueries(fetchMock)[0]!.get("main")).toBe("auto");
  });

  it("skips both selection steps under 'Överraska mig'", async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Överraska mig" }));

    await screen.findByRole("heading", { name: "Tre förslag" });
    const [query] = directionsQueries(fetchMock);
    expect(query!.get("intent")).toBe("surprise_me");
    expect(query!.get("main")).toBe("auto");
    expect(query!.get("pantry")).toBeNull();
  });
});

describe("GuidedFlow — back navigation", () => {
  it("returns through the steps with every earlier selection still showing", async () => {
    const user = userEvent.setup();
    stubApi();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Middagsidé" }));
    await user.click(await screen.findByRole("button", { name: "kycklingfilé" }));
    await user.click(await screen.findByRole("button", { name: "ris" }));
    await user.click(screen.getByRole("button", { name: "Visa förslag" }));
    await screen.findByRole("heading", { name: "Tre förslag" });

    await user.click(screen.getByRole("button", { name: "Tillbaka" }));

    // Back on the pantry grid, with "ris" still selected — the household does not
    // redo work it already did.
    await screen.findByRole("heading", { name: "Vad har du hemma?" });
    expect(screen.getByRole("button", { name: "ris" }).getAttribute("aria-pressed")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Tillbaka" }));
    await screen.findByRole("heading", { name: "Vilken huvudingrediens?" });

    await user.click(screen.getByRole("button", { name: "Tillbaka" }));
    await screen.findByRole("heading", { name: "Vad är du sugen på?" });
    expect(screen.getByRole("button", { name: "Middagsidé" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("leaves the flow entirely from the first step", async () => {
    const user = userEvent.setup();
    stubApi();
    const onExit = renderFlow();

    await user.click(await screen.findByRole("button", { name: "Till ikväll" }));

    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

describe("GuidedFlow — the no-directions empty state (UX_FLOW §9)", () => {
  it("offers to loosen rather than dead-ending", async () => {
    const user = userEvent.setup();
    stubApi(noDirections);
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Använd det jag har" }));
    await user.click(await screen.findByRole("button", { name: "kycklingfilé" }));
    await user.click(await screen.findByRole("button", { name: "ris" }));
    await user.click(screen.getByRole("button", { name: "Visa förslag" }));

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bortse från vad jag har hemma" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Visa alla huvudingredienser" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ändra mina val" })).toBeTruthy();
  });

  it("re-requests without the pantry when that constraint is dropped", async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi(noDirections);
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Använd det jag har" }));
    await user.click(await screen.findByRole("button", { name: "kycklingfilé" }));
    await user.click(await screen.findByRole("button", { name: "ris" }));
    await user.click(screen.getByRole("button", { name: "Visa förslag" }));

    await user.click(await screen.findByRole("button", { name: "Bortse från vad jag har hemma" }));

    await waitFor(() => expect(directionsQueries(fetchMock)).toHaveLength(2));
    const [first, second] = directionsQueries(fetchMock);
    expect(first!.get("pantry")).toBe("ris");
    expect(second!.get("pantry")).toBeNull();
    expect(second!.get("main")).toBe("kycklingfile");
  });

  it("re-requests without the main ingredient when that constraint is dropped", async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi(noDirections);
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Middagsidé" }));
    await user.click(await screen.findByRole("button", { name: "kycklingfilé" }));
    await user.click(screen.getByRole("button", { name: "Hoppa över" }));

    await user.click(await screen.findByRole("button", { name: "Visa alla huvudingredienser" }));

    await waitFor(() => expect(directionsQueries(fetchMock)).toHaveLength(2));
    expect(directionsQueries(fetchMock)[1]!.get("main")).toBe("any");
  });

  it("recovers to real cards once the constraint is loosened", async () => {
    const user = userEvent.setup();
    let body: unknown = noDirections;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("/api/guided/options")
          ? jsonResponse(200, options)
          : jsonResponse(200, body),
      ),
    );
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Middagsidé" }));
    await user.click(await screen.findByRole("button", { name: "kycklingfilé" }));
    await user.click(screen.getByRole("button", { name: "Hoppa över" }));
    await screen.findByRole("button", { name: "Visa alla huvudingredienser" });

    body = threeDirections;
    await user.click(screen.getByRole("button", { name: "Visa alla huvudingredienser" }));

    expect(await screen.findByRole("heading", { name: "Kycklinggryta" })).toBeTruthy();
  });

  it("sends a household whose own constraints leave nothing to its profile, not to the loosen actions", async () => {
    const user = userEvent.setup();
    stubApi({ directions: [], reason: "no_safe_templates", mainIngredientId: null, portions: 2 });
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Överraska mig" }));

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Bortse från vad jag har hemma" })).toBeNull();
    expect(screen.getByRole("button", { name: "Börja om" })).toBeTruthy();
  });
});

describe("GuidedFlow — portion confirmation", () => {
  it("steps the portion count up and down without typing", async () => {
    const user = userEvent.setup();
    stubApi();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Överraska mig" }));
    await user.click((await screen.findAllByRole("button", { name: "Välj" }))[0]!);

    await screen.findByRole("heading", { name: "Hur många portioner?" });
    await user.click(screen.getByRole("button", { name: "Fler portioner" }));
    expect(screen.getByRole("status").textContent).toBe("För 3 portioner");

    await user.click(screen.getByRole("button", { name: "Färre portioner" }));
    expect(screen.getByRole("status").textContent).toBe("För 2 portioner");
  });

  it("carries the confirmed count into the shopping list", async () => {
    const user = userEvent.setup();
    stubApi();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Överraska mig" }));
    await user.click((await screen.findAllByRole("button", { name: "Välj" }))[0]!);
    await user.click(await screen.findByRole("button", { name: "Fler portioner" }));
    await user.click(screen.getByRole("button", { name: "Till inköpslistan" }));

    expect(await screen.findByText("För 3 portioner")).toBeTruthy();
  });
});

describe("pantry input is never persisted (CLAUDE.md non-negotiable)", () => {
  // Session-scoped and ephemeral by decision, not by omission. If a change makes one
  // of these fail, the change is wrong — do not relax the assertion. A persistent
  // pantry inventory goes stale and is explicitly out of scope for MVP.

  it("writes nothing to localStorage while the household selects and submits a pantry", async () => {
    const user = userEvent.setup();
    stubApi();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Använd det jag har" }));
    await user.click(await screen.findByRole("button", { name: "kycklingfilé" }));
    await user.click(await screen.findByRole("button", { name: "ris" }));
    await user.click(await screen.findByRole("button", { name: "gul lök" }));
    await user.click(screen.getByRole("button", { name: "Visa förslag" }));
    await screen.findByRole("heading", { name: "Tre förslag" });

    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it("stores no pantry ingredient id even once a shopping list is saved", async () => {
    const user = userEvent.setup();
    stubApi();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Använd det jag har" }));
    await user.click(await screen.findByRole("button", { name: "kycklingfilé" }));
    await user.click(await screen.findByRole("button", { name: "ris" }));
    await user.click(await screen.findByRole("button", { name: "gul lök" }));
    await user.click(screen.getByRole("button", { name: "Visa förslag" }));
    await user.click((await screen.findAllByRole("button", { name: "Välj" }))[0]!);
    await user.click(await screen.findByRole("button", { name: "Till inköpslistan" }));
    await screen.findByText("Har hemma (1)");

    // The accepted dish's shopping list is the only thing on the device, and it
    // holds item names for that dish — never the pantry selection, and never an
    // ingredient id.
    const stored = Object.keys(localStorage).map((key) => localStorage.getItem(key) ?? "");
    expect(Object.keys(localStorage)).toEqual(["matmatch.shoppingList"]);
    for (const value of stored) {
      expect(value).not.toContain("gul-lok");
      expect(value).not.toContain("kycklingfile");
      expect(value).not.toContain("pantry");
    }
  });

  it("sends the pantry only as a query parameter, never in a request body", async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Använd det jag har" }));
    await user.click(await screen.findByRole("button", { name: "kycklingfilé" }));
    await user.click(await screen.findByRole("button", { name: "ris" }));
    await user.click(screen.getByRole("button", { name: "Visa förslag" }));
    await screen.findByRole("heading", { name: "Tre förslag" });

    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.body).toBeUndefined();
    }
  });
});

describe("GuidedFlow — failed requests offer a way forward", () => {
  it("retries the ingredient grids rather than showing 'Hämtar…' forever", async () => {
    const user = userEvent.setup();
    let failOptions = true;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/guided/options")) {
        if (failOptions) {
          return jsonResponse(500, { error: { code: "internal", message: "gick fel" } });
        }
        return jsonResponse(200, options);
      }
      return jsonResponse(200, threeDirections);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Middagsidé" }));
    await screen.findByRole("heading", { name: "Vilken huvudingrediens?" });

    // Not a permanent "Hämtar ingredienser…" over a request that is no longer running.
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Hämtar ingredienser…")).toBeNull();

    failOptions = false;
    await user.click(screen.getByRole("button", { name: "Försök igen" }));

    expect(await screen.findByRole("button", { name: "kycklingfilé" })).toBeTruthy();
  });

  it("drops a stale direction set when a refetch fails, so no card answers an abandoned question", async () => {
    const user = userEvent.setup();
    let failDirections = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/guided/options")) return jsonResponse(200, options);
        if (failDirections) {
          return jsonResponse(500, { error: { code: "internal", message: "gick fel" } });
        }
        return jsonResponse(200, threeDirections);
      }),
    );
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Middagsidé" }));
    await user.click(await screen.findByRole("button", { name: "kycklingfilé" }));
    await user.click(await screen.findByRole("button", { name: "ris" }));
    await user.click(screen.getByRole("button", { name: "Visa förslag" }));
    await screen.findByRole("heading", { name: "Kycklinggryta" });

    failDirections = true;
    await user.click(screen.getByRole("button", { name: "Tillbaka" }));
    await user.click(await screen.findByRole("button", { name: "gul lök" }));
    await user.click(screen.getByRole("button", { name: "Visa förslag" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Kycklinggryta" })).toBeNull();
    expect(screen.getByRole("button", { name: "Försök igen" })).toBeTruthy();
  });
});

describe("GuidedFlow — a shopping list survives a reload (UX_FLOW §7)", () => {
  const stored: StoredShoppingList = {
    version: 1,
    templateId: "gryta",
    templateName: "Kycklinggryta",
    substitutions: [],
    items: [
      { name: "Kycklingfilé", section: "to_buy", bought: false },
      { name: "Ris", section: "have_at_home", bought: false },
    ],
  };

  it("opens on the resumed list rather than back at the intent chips", async () => {
    // `resume` is exactly what `loadAnyShoppingList()` returned, so the list is on
    // the device — that is where ShoppingList reads its items from.
    localStorage.setItem("matmatch.shoppingList", JSON.stringify(stored));
    stubApi();
    renderFlow(vi.fn(), stored);

    expect(await screen.findByRole("heading", { name: "Kycklinggryta", level: 2 })).toBeTruthy();
    expect(screen.getByText("Att köpa (1)")).toBeTruthy();
    expect(screen.getByText("Har hemma (1)")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Vad är du sugen på?" })).toBeNull();
  });

  it("keeps the checked state the household left in the shop", async () => {
    localStorage.setItem(
      "matmatch.shoppingList",
      JSON.stringify({ ...stored, items: [{ ...stored.items[0]!, bought: true }, stored.items[1]!] }),
    );
    stubApi();
    renderFlow(vi.fn(), stored);

    const checkbox = await screen.findByRole("checkbox");
    expect((checkbox as HTMLInputElement).checked).toBe(true);
  });

  it("offers a way back into the flow from the shopping list", async () => {
    const user = userEvent.setup();
    localStorage.setItem("matmatch.shoppingList", JSON.stringify(stored));
    stubApi();
    renderFlow(vi.fn(), stored);

    await screen.findByRole("heading", { name: "Kycklinggryta", level: 2 });
    await user.click(screen.getByRole("button", { name: "Tillbaka" }));

    // Back into the flow rather than stuck on the list — "Börja om" wipes it, so it
    // cannot be the only affordance. A resumed list has no earlier step behind it,
    // so that means the chips.
    expect(await screen.findByRole("heading", { name: "Vad är du sugen på?" })).toBeTruthy();
  });
});
