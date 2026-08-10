import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuidedFlow } from "./GuidedFlow";
import { SHOPPING_LIST_VERSION, type StoredShoppingList } from "./shoppingListStorage";

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
  // A household with a fish allergy: "lax" resolves in the catalog but never in
  // `mainIngredients` — the filter's explanation path (requirement 4), not the
  // selectable grid.
  excludedMainIngredients: [{ id: "lax", name: "Lax", allergies: ["fish"] }],
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
      { role: "protein", name: "Kycklingfilé", substituted: false, inPantry: false, allergens: [] },
      { role: "starch", name: "Ris", substituted: false, inPantry: true, allergens: [] },
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

describe("GuidedFlow — no typing anywhere except step 2's filter (UX_FLOW §1/§2, #110)", () => {
  it("renders no text input on any step except the main-ingredient filter", async () => {
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
    // The one exception, and only here: step 2's type-to-filter over the
    // household's own safe candidate set (#110) — still not a search box, so it
    // carries no `type="search"` or `role="searchbox"` affordance.
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryAllByRole("searchbox")).toEqual([]);

    await user.click(await screen.findByRole("button", { name: "kycklingfilé" }));
    await screen.findByRole("heading", { name: "Vad har du hemma?" });
    assertNoTextEntry();

    await user.click(screen.getByRole("button", { name: "Hoppa över" }));
    await screen.findByRole("heading", { name: "Tre förslag" });
    assertNoTextEntry();
  });
});

describe("GuidedFlow — step 2's type-to-filter (#110)", () => {
  it("narrows the grid to a substring match, case- and diacritics-insensitive", async () => {
    const user = userEvent.setup();
    stubApi();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Middagsidé" }));
    await screen.findByRole("button", { name: "kycklingfilé" });
    expect(screen.getByRole("button", { name: "svarta bönor" })).toBeTruthy();

    await user.type(screen.getByRole("textbox"), "BONOR");

    expect(screen.getByRole("button", { name: "svarta bönor" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "kycklingfilé" })).toBeNull();
  });

  it("clearing the input restores the full grid", async () => {
    const user = userEvent.setup();
    stubApi();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Middagsidé" }));
    const input = await screen.findByRole("textbox");

    await user.type(input, "bonor");
    expect(screen.queryByRole("button", { name: "kycklingfilé" })).toBeNull();

    await user.clear(input);
    expect(screen.getByRole("button", { name: "kycklingfilé" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "svarta bönor" })).toBeTruthy();
  });

  it("selects the ingredient that was actually tapped, regardless of the query that surfaced it", async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Middagsidé" }));
    await user.type(await screen.findByRole("textbox"), "kyckling");
    await user.click(screen.getByRole("button", { name: "kycklingfilé" }));
    await user.click(await screen.findByRole("button", { name: "Hoppa över" }));

    await screen.findByRole("heading", { name: "Tre förslag" });
    expect(directionsQueries(fetchMock)[0]!.get("main")).toBe("kycklingfile");
  });

  it("shows a plain 'ingen träff' state with the full grid still available below it", async () => {
    const user = userEvent.setup();
    stubApi();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Middagsidé" }));
    await screen.findByRole("button", { name: "kycklingfilé" });

    await user.type(screen.getByRole("textbox"), "nötkött");

    expect(screen.getByText("Ingen träff.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "kycklingfilé" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "svarta bönor" })).toBeTruthy();
  });

  it("explains an allergy-excluded match instead of returning nothing", async () => {
    const user = userEvent.setup();
    stubApi();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Middagsidé" }));
    await screen.findByRole("button", { name: "kycklingfilé" });

    await user.type(screen.getByRole("textbox"), "lax");

    expect(screen.getByText("Lax är utesluten på grund av fiskallergi.")).toBeTruthy();
    // Display only — never a tap target, and it never widens the selectable set.
    expect(screen.queryByRole("button", { name: "Lax" })).toBeNull();
    expect(screen.queryByText("Ingen träff.")).toBeNull();
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
    version: SHOPPING_LIST_VERSION,
    templateId: "gryta",
    templateName: "Kycklinggryta",
    substitutions: [],
    items: [
      { name: "Kycklingfilé", section: "to_buy", bought: false, allergens: [] },
      { name: "Ris", section: "have_at_home", bought: false, allergens: [] },
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

describe("GuidedFlow — the diner picker (#112)", () => {
  const twoDiners = [{ label: "Vuxen 1" }, { label: "Elsa" }];

  /** Both endpoints answer with the roster; directions echo back the diner set they saw. */
  function stubApiWithDiners(rosters: { label: string }[] = twoDiners) {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/guided/options")) {
        return jsonResponse(200, { ...options, diners: rosters });
      }
      if (url.startsWith("/api/guided/directions")) return jsonResponse(200, threeDirections);
      return jsonResponse(200, { instructions: null, reason: "not_configured" });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function optionsQueries(fetchMock: ReturnType<typeof vi.fn>): URLSearchParams[] {
    return fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.startsWith("/api/guided/options"))
      .map((url) => new URLSearchParams(url.split("?")[1] ?? ""));
  }

  async function reachDirections(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByRole("heading", { name: "Vad är du sugen på?" });
    await user.click(screen.getByRole("button", { name: "Middagsidé" }));
    await user.click(await screen.findByRole("button", { name: "kycklingfilé" }));
    await user.click(await screen.findByRole("button", { name: "Hoppa över" }));
    await screen.findByRole("heading", { name: "Tre förslag" });
  }

  it("does not gate the flow: the first request carries no diner set and the cards arrive", async () => {
    const user = userEvent.setup();
    const fetchMock = stubApiWithDiners();
    renderFlow();

    await reachDirections(user);

    expect(screen.getByRole("heading", { name: "Kycklinggryta" })).toBeTruthy();
    expect(optionsQueries(fetchMock)[0]!.get("diners")).toBeNull();
    expect(directionsQueries(fetchMock)[0]!.get("diners")).toBeNull();
  });

  it("shows every member selected, below the cards", async () => {
    const user = userEvent.setup();
    stubApiWithDiners();
    renderFlow();

    await reachDirections(user);

    const group = screen.getByRole("group", { name: "Vilka äter?" });
    for (const label of ["Vuxen 1", "Elsa"]) {
      const chip = screen.getByRole("button", { name: label, pressed: true });
      expect(group.contains(chip)).toBe(true);
    }
  });

  it("refetches both endpoints with the same diner set when one is deselected", async () => {
    // The pairing requirement: a grid built for one set and directions for another
    // would offer targets that are then rejected.
    const user = userEvent.setup();
    const fetchMock = stubApiWithDiners();
    renderFlow();

    await reachDirections(user);
    await user.click(screen.getByRole("button", { name: "Elsa" }));

    await waitFor(() => {
      expect(optionsQueries(fetchMock).at(-1)!.get("diners")).toBe("0");
    });
    await waitFor(() => {
      expect(directionsQueries(fetchMock).at(-1)!.get("diners")).toBe("0");
    });

    // Every request either carries the same diner set as its neighbour or predates
    // the change — never two different live sets.
    const optionsSets = optionsQueries(fetchMock).map((query) => query.get("diners"));
    const directionsSets = directionsQueries(fetchMock).map((query) => query.get("diners"));
    expect(optionsSets.at(-1)).toBe(directionsSets.at(-1));
  });

  it("cannot deselect the last remaining diner", async () => {
    const user = userEvent.setup();
    stubApiWithDiners();
    renderFlow();

    await reachDirections(user);
    await user.click(screen.getByRole("button", { name: "Elsa" }));

    const lastOne = await screen.findByRole("button", { name: "Vuxen 1", pressed: true });
    await waitFor(() => expect((lastOne as HTMLButtonElement).disabled).toBe(true));

    await user.click(lastOne);
    expect(screen.getByRole("button", { name: "Vuxen 1", pressed: true })).toBeTruthy();
  });

  it("renders nothing for a one-member household", async () => {
    const user = userEvent.setup();
    stubApiWithDiners([{ label: "Vuxen 1" }]);
    renderFlow();

    await reachDirections(user);

    expect(screen.queryByRole("group", { name: "Vilka äter?" })).toBeNull();
  });

  it("names the cross-contamination limit rather than implying it is handled", async () => {
    const user = userEvent.setup();
    stubApiWithDiners();
    renderFlow();

    await reachDirections(user);

    expect(
      screen.getByText(/Rester och gemensamma kastruller kan ändå innehålla allergener/),
    ).toBeTruthy();
  });

  it("writes nothing to localStorage when diners are selected", async () => {
    const user = userEvent.setup();
    stubApiWithDiners();
    renderFlow();

    await reachDirections(user);
    await user.click(screen.getByRole("button", { name: "Elsa" }));
    await user.click(await screen.findByRole("button", { name: "Elsa", pressed: false }));

    expect(localStorage.length).toBe(0);
  });
});

describe("GuidedFlow — a failed options refetch drops the stale grid (#112)", () => {
  it("does not leave a grid built for a different diner set tappable", async () => {
    const user = userEvent.setup();

    let optionsCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/guided/options")) {
        optionsCalls += 1;
        if (optionsCalls === 1) {
          return jsonResponse(200, { ...options, diners: [{ label: "Vuxen 1" }, { label: "Elsa" }] });
        }
        throw new TypeError("network down");
      }
      if (String(url).startsWith("/api/guided/directions")) return jsonResponse(200, threeDirections);
      return jsonResponse(200, { instructions: null, reason: "not_configured" });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderFlow();
    await screen.findByRole("heading", { name: "Vad är du sugen på?" });
    await user.click(screen.getByRole("button", { name: "Middagsidé" }));
    await user.click(await screen.findByRole("button", { name: "kycklingfilé" }));
    await user.click(await screen.findByRole("button", { name: "Hoppa över" }));
    await screen.findByRole("heading", { name: "Tre förslag" });

    await user.click(screen.getByRole("button", { name: "Elsa" }));

    // The grid the previous diner set produced is gone rather than left tappable.
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("network down"));
    await user.click(screen.getByRole("button", { name: "Tillbaka" }));
    await screen.findByRole("heading", { name: "Vad har du hemma?" });
    expect(screen.queryByRole("button", { name: "ris" })).toBeNull();
  });
});
