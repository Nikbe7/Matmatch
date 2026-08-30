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
      { role: "protein", name: "Kycklingfilé", slotIndex: 0, ingredientId: "kycklingfile", substituted: false, inPantry: false, quantity: { kind: "amount", amount: 400, unit: "g" } },
      { role: "starch", name: "Ris", slotIndex: 1, ingredientId: "ris", substituted: false, inPantry: true, quantity: { kind: "amount", amount: 400, unit: "g" } },
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
    expect(screen.getByText("Kycklinggryta")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Välj" })).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Kycklinggryta" }));

    await screen.findByRole("heading", { name: "Hur många portioner?" });
    expect(screen.getByRole("status").textContent).toBe("För 2 portioner");

    await user.click(screen.getByRole("button", { name: "Till inköpslistan" }));

    await screen.findByRole("heading", { name: "Kycklinggryta", level: 2 });
    expect(screen.getByText("Behöver handlas (1)")).toBeTruthy();
    // The pantry selection carries through: the ingredient the household said it
    // has starts in "Har hemma" rather than on the shopping list.
    expect(screen.getByText("Har hemma (1)")).toBeTruthy();

    const [query] = directionsQueries(fetchMock);
    expect(query!.get("intent")).toBe("dinner_idea");
    expect(query!.get("main")).toBe("kycklingfile");
    expect(query!.get("pantry")).toBe("ris");
  });

  it("shows three cards with a cost tier label that is a tier, never a price", async () => {
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

    // The label is a bare text node beside the prep-time text in the same <p>
    // (`.direction-card__meta`), so it has no element of its own for `getByText` to
    // match — check the meta rows' combined text instead.
    const metaText = document.querySelectorAll(".direction-card__meta");
    expect(Array.from(metaText).map((el) => el.textContent)).toEqual([
      expect.stringContaining("Billigt"),
      expect.stringContaining("Mellanpris"),
      expect.stringContaining("Dyrare"),
    ]);
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

describe("GuidedFlow — the direction card itself is the tap target (#174)", () => {
  it("chooses a direction by activating the card, with no 'Välj' button anywhere", async () => {
    const user = userEvent.setup();
    stubApi();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Överraska mig" }));
    await screen.findByRole("heading", { name: "Tre förslag" });

    expect(screen.queryAllByRole("button", { name: "Välj" })).toEqual([]);
    const card = screen.getByRole("button", { name: "Kycklinggryta" });
    // The card's accessible name is exactly the dish name — not the summary or
    // meta line it also carries as visible text.
    expect(card.tagName).toBe("BUTTON");

    await user.click(card);

    await screen.findByRole("heading", { name: "Hur många portioner?" });
  });
});

// #206: the three-step progress indicator that replaced the plain "Steg 1 av 3".
describe("GuidedFlow — step progress (#206)", () => {
  it("fills one more segment per choice step and keeps the sentence for screen readers", async () => {
    const user = userEvent.setup();
    stubApi();
    renderFlow();

    const filled = () => document.querySelectorAll(".guided-progress__segment--done").length;
    const segments = () => document.querySelectorAll(".guided-progress__segment").length;

    await screen.findByRole("heading", { name: "Vad är du sugen på?" });
    expect(segments()).toBe(3);
    expect(filled()).toBe(1);
    // The bars are aria-hidden; the wording a screen reader had before is still here.
    expect(screen.getByText("Steg 1 av 3")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Middagsidé" }));
    await screen.findByRole("heading", { name: "Vilken huvudingrediens?" });
    expect(filled()).toBe(2);

    await user.click(await screen.findByRole("button", { name: "kycklingfilé" }));
    await screen.findByRole("heading", { name: "Vad har du hemma?" });
    expect(filled()).toBe(3);
  });

  it("shows no progress indicator on the result steps", async () => {
    // They are named, not numbered: a household reading "Tre förslag" is no longer
    // walking a sequence, and a full bar there would say the flow is over when the
    // shopping list has not been built.
    const user = userEvent.setup();
    stubApi();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Middagsidé" }));
    await user.click(await screen.findByRole("button", { name: "kycklingfilé" }));
    await user.click(await screen.findByRole("button", { name: "Hoppa över" }));
    await screen.findByRole("heading", { name: "Tre förslag" });

    expect(document.querySelectorAll(".guided-progress__segment")).toHaveLength(0);
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

  // The "explains an allergy-excluded match" test that stood here is gone with
  // `excludedMainIngredients` (#224). A dietary flag excludes a whole dish rather than
  // one ingredient, so there is no per-ingredient exclusion left for the search box to
  // explain — an unmatched query is simply "Ingen träff.", asserted above.
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

    expect(await screen.findByText("Kycklinggryta")).toBeTruthy();
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
    await user.click(await screen.findByRole("button", { name: "Kycklinggryta" }));

    await screen.findByRole("heading", { name: "Hur många portioner?" });
    await user.click(screen.getByRole("button", { name: "Fler portioner" }));
    expect(screen.getByRole("status").textContent).toBe("För 3 portioner");

    await user.click(screen.getByRole("button", { name: "Färre portioner" }));
    expect(screen.getByRole("status").textContent).toBe("För 2 portioner");
  });

  it("uses singular 'portion' at 1, plural 'portioner' above it (#176)", async () => {
    const user = userEvent.setup();
    stubApi();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Överraska mig" }));
    await user.click(await screen.findByRole("button", { name: "Kycklinggryta" }));

    await screen.findByRole("heading", { name: "Hur många portioner?" });
    expect(screen.getByRole("status").textContent).toBe("För 2 portioner");

    await user.click(screen.getByRole("button", { name: "Färre portioner" }));
    expect(screen.getByRole("status").textContent).toBe("För 1 portion");

    await user.click(screen.getByRole("button", { name: "Fler portioner" }));
    expect(screen.getByRole("status").textContent).toBe("För 2 portioner");
  });

  it("carries the confirmed count into the shopping list", async () => {
    const user = userEvent.setup();
    stubApi();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Överraska mig" }));
    await user.click(await screen.findByRole("button", { name: "Kycklinggryta" }));
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

  it("stores no pantry selection that isn't itself part of the accepted dish", async () => {
    const user = userEvent.setup();
    stubApi();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Använd det jag har" }));
    await user.click(await screen.findByRole("button", { name: "kycklingfilé" }));
    await user.click(await screen.findByRole("button", { name: "ris" }));
    // "gul lök" is tapped as a pantry item but never appears in `direction()`'s own
    // two slots below — the fixture's one guaranteed case of a pantry pick the
    // accepted dish does not itself contain.
    await user.click(await screen.findByRole("button", { name: "gul lök" }));
    await user.click(screen.getByRole("button", { name: "Visa förslag" }));
    await user.click(await screen.findByRole("button", { name: "Kycklinggryta" }));
    await user.click(await screen.findByRole("button", { name: "Till inköpslistan" }));
    await screen.findByText("Har hemma (1)");

    // The accepted dish's shopping list is the only thing on the device. As of #124
    // it legitimately carries each item's own `ingredientId` (the ingredient-swap
    // popover's tap target) — "kycklingfile" and "ris" are expected here because
    // they are this dish's own protein and starch slots, not because the pantry
    // selection leaked. "gul-lok" is the invariant this test actually guards: a
    // pantry pick that never became part of the dish must never reach storage.
    const stored = Object.keys(localStorage).map((key) => localStorage.getItem(key) ?? "");
    expect(Object.keys(localStorage)).toEqual(["matmatch.shoppingList"]);
    for (const value of stored) {
      expect(value).not.toContain("gul-lok");
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
    // A controlled, deferred options response — resolved explicitly below,
    // rather than an immediately-rejecting mock — so the failure lands only
    // once the flow is actually on the "main" step, not in a race against the
    // click that gets it there (the error screen replacing the step's own
    // content means a failure that lands mid-click would otherwise unmount
    // the very button `user.click` is about to press).
    let resolveOptions: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/guided/options")) {
        return new Promise<Response>((resolve) => {
          resolveOptions = resolve;
        });
      }
      return jsonResponse(200, threeDirections);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Middagsidé" }));
    await screen.findByRole("heading", { name: "Vilken huvudingrediens?" });

    resolveOptions!(jsonResponse(500, { error: { code: "internal", message: "gick fel" } }));

    // The error screen replaces the step's own content rather than stacking
    // above it (#170) — not a permanent "Hämtar ingredienser…" over a request
    // that is no longer running, and no "Vilken huvudingrediens?" underneath it.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Försök igen om en liten stund.");
    expect(screen.queryByRole("heading", { name: "Vilken huvudingrediens?" })).toBeNull();
    // The server's raw message never reaches the DOM — the code survives only as
    // the quiet reference line below the action (#170).
    expect(screen.queryByText("gick fel")).toBeNull();
    expect(document.body.textContent).toContain("internal");
    expect(screen.queryByText("Hämtar ingredienser…")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Försök igen" }));
    resolveOptions!(jsonResponse(200, options));

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
    await screen.findByText("Kycklinggryta");

    failDirections = true;
    await user.click(screen.getByRole("button", { name: "Tillbaka" }));
    await user.click(await screen.findByRole("button", { name: "gul lök" }));
    await user.click(screen.getByRole("button", { name: "Visa förslag" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Kycklinggryta")).toBeNull();
    expect(screen.getByRole("button", { name: "Försök igen" })).toBeTruthy();
  });
});

describe("GuidedFlow — the error screen replaces the step's content, never stacks above it (#170, #174)", () => {
  it("does not render the step's heading or controls while the directions error screen is shown", async () => {
    let resolveDirections: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/guided/options")) return jsonResponse(200, options);
      if (url.startsWith("/api/guided/directions")) {
        return new Promise<Response>((resolve) => {
          resolveDirections = resolve;
        });
      }
      return jsonResponse(200, { instructions: null, reason: "not_configured" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Middagsidé" }));
    await user.click(await screen.findByRole("button", { name: "kycklingfilé" }));
    await user.click(await screen.findByRole("button", { name: "Hoppa över" }));
    await screen.findByRole("heading", { name: "Tre förslag" });

    resolveDirections!(jsonResponse(500, { error: { code: "internal", message: "gick fel" } }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    // Never stacked: the directions step's own heading is gone while the error
    // screen is on screen, not just visually underneath it.
    expect(screen.queryByRole("heading", { name: "Tre förslag" })).toBeNull();
    // The back button survives the replacement — it is the one way out of a
    // broken request that does not depend on the request succeeding.
    expect(screen.getByRole("button", { name: "Tillbaka" })).toBeTruthy();
  });
});

describe("GuidedFlow — loading states are placeholders, not spinners on empty space (#170)", () => {
  it("shows an ingredient-grid-shaped skeleton while the options request is in flight", async () => {
    let resolveOptions: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/guided/options")) {
        return new Promise<Response>((resolve) => {
          resolveOptions = resolve;
        });
      }
      return jsonResponse(200, threeDirections);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Middagsidé" }));
    await screen.findByRole("heading", { name: "Vilken huvudingrediens?" });

    const grid = document.querySelector(".ingredient-grid");
    expect(grid).toBeTruthy();
    expect(grid!.querySelectorAll(".skeleton-line--chip").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "kycklingfilé" })).toBeNull();

    resolveOptions!(jsonResponse(200, options));

    expect(await screen.findByRole("button", { name: "kycklingfilé" })).toBeTruthy();
  });

  it("shows three placeholder direction cards while directions are in flight", async () => {
    let resolveDirections: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/guided/options")) return jsonResponse(200, options);
      if (url.startsWith("/api/guided/directions")) {
        return new Promise<Response>((resolve) => {
          resolveDirections = resolve;
        });
      }
      return jsonResponse(200, { instructions: null, reason: "not_configured" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: "Middagsidé" }));
    await user.click(await screen.findByRole("button", { name: "kycklingfilé" }));
    await user.click(screen.getByRole("button", { name: "Hoppa över" }));
    await screen.findByRole("heading", { name: "Tre förslag" });

    const skeletonCards = document.querySelectorAll(".direction-list .direction-card");
    expect(skeletonCards).toHaveLength(3);
    expect(screen.queryByText("Kycklinggryta")).toBeNull();

    resolveDirections!(jsonResponse(200, threeDirections));

    await screen.findByText("Kycklinggryta");
  });
});

describe("GuidedFlow — a shopping list survives a reload (UX_FLOW §7)", () => {
  const stored: StoredShoppingList = {
    version: SHOPPING_LIST_VERSION,
    templateId: "gryta",
    templateName: "Kycklinggryta",
    substitutions: [],
    items: [
      { name: "Kycklingfilé", section: "to_buy", bought: false, quantity: { kind: "amount", amount: 400, unit: "g" }, slotIndex: 0, ingredientId: "kycklingfile" },
      { name: "Ris", section: "have_at_home", bought: false, quantity: { kind: "amount", amount: 400, unit: "g" }, slotIndex: 1, ingredientId: "ris" },
    ],
  };

  it("opens on the resumed list rather than back at the intent chips", async () => {
    // `resume` is exactly what `loadAnyShoppingList()` returned, so the list is on
    // the device — that is where ShoppingList reads its items from.
    localStorage.setItem("matmatch.shoppingList", JSON.stringify(stored));
    stubApi();
    renderFlow(vi.fn(), stored);

    expect(await screen.findByRole("heading", { name: "Kycklinggryta", level: 2 })).toBeTruthy();
    expect(screen.getByText("Behöver handlas (1)")).toBeTruthy();
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

    expect(screen.getByText("Kycklinggryta")).toBeTruthy();
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

  it("says nothing about allergens — the picker scopes dietary flags and portions only", async () => {
    // Inverts the pre-#224 assertion; see the twin in App.test.tsx.
    const user = userEvent.setup();
    stubApiWithDiners();
    renderFlow();

    await reachDirections(user);

    expect(screen.getByRole("group", { name: "Vilka äter?" }).textContent).not.toMatch(
      /allergen/i,
    );
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

describe("GuidedFlow — a diner change after choosing keeps or explains (#133)", () => {
  const twoDiners = [{ label: "Vuxen 1" }, { label: "Elsa" }];

  async function reachPortions(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByRole("heading", { name: "Vad är du sugen på?" });
    await user.click(screen.getByRole("button", { name: "Middagsidé" }));
    await user.click(await screen.findByRole("button", { name: "kycklingfilé" }));
    await user.click(await screen.findByRole("button", { name: "Hoppa över" }));
    await screen.findByRole("heading", { name: "Tre förslag" });
    await user.click(await screen.findByRole("button", { name: "Kycklinggryta" }));
    await screen.findByRole("heading", { name: "Hur många portioner?" });
  }

  it("keeps the chosen dish on the portions step when the new diner set still allows it", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/guided/options")) {
        return jsonResponse(200, { ...options, diners: twoDiners });
      }
      if (url.startsWith("/api/guided/directions")) return jsonResponse(200, threeDirections);
      return jsonResponse(200, { instructions: null, reason: "not_configured" });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderFlow();

    await reachPortions(user);
    const callsBefore = directionsQueries(fetchMock).length;

    await user.click(screen.getByRole("button", { name: "Elsa" }));

    await waitFor(() => expect(directionsQueries(fetchMock).length).toBeGreaterThan(callsBefore));
    // Never bounced off the portions step, and still the same dish.
    expect(screen.getByRole("heading", { name: "Hur många portioner?" })).toBeTruthy();
    expect(screen.getByText("Kycklinggryta")).toBeTruthy();
    expect(directionsQueries(fetchMock).at(-1)!.get("keep")).toBe("gryta");
  });

  it("disables 'Till inköpslistan' and the diner picker while a keep/replace check is in flight", async () => {
    const user = userEvent.setup();
    let resolveDirections: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/guided/options")) {
        return jsonResponse(200, { ...options, diners: twoDiners });
      }
      if (url.startsWith("/api/guided/directions")) {
        const query = new URLSearchParams(url.split("?")[1] ?? "");
        // The initial fetch (reaching "Tre förslag") resolves immediately; only
        // the diner-change one hangs, so the race window is exactly the one
        // this test is about.
        if (query.get("keep")) {
          return new Promise<Response>((resolve) => {
            resolveDirections = resolve;
          });
        }
        return jsonResponse(200, threeDirections);
      }
      return jsonResponse(200, { instructions: null, reason: "not_configured" });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderFlow();

    await reachPortions(user);
    await user.click(screen.getByRole("button", { name: "Elsa" }));

    const confirmButton = await screen.findByRole("button", { name: "Till inköpslistan" });
    await waitFor(() => expect((confirmButton as HTMLButtonElement).disabled).toBe(true));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Elsa" }) as HTMLButtonElement).disabled).toBe(true),
    );

    resolveDirections!(jsonResponse(200, threeDirections));

    await waitFor(() => expect((confirmButton as HTMLButtonElement).disabled).toBe(false));
  });

  it("bounces back to the cards and names the affected member once the new diner set makes it unsafe", async () => {
    const user = userEvent.setup();
    let directionsCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/guided/options")) {
        return jsonResponse(200, { ...options, diners: twoDiners });
      }
      if (url.startsWith("/api/guided/directions")) {
        directionsCalls += 1;
        if (directionsCalls === 1) return jsonResponse(200, threeDirections);
        // The dish chosen at the cards step ("gryta") no longer comes back.
        return jsonResponse(200, {
          directions: [direction("wok", "Kycklingwok"), direction("pasta", "Kycklingpasta")],
          mainIngredientId: "kycklingfile",
          portions: 2,
          replacedFor: "Elsa",
        });
      }
      return jsonResponse(200, { instructions: null, reason: "not_configured" });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderFlow();

    await reachPortions(user);
    await user.click(screen.getByRole("button", { name: "Elsa" }));

    // Never a silent swap: back to the cards, with the reason and the new set —
    // never left showing "Kycklinggryta" as though nothing happened.
    await screen.findByRole("heading", { name: "Tre förslag" });
    expect(screen.getByText("Rätten passar inte Elsa, här är ett nytt förslag")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Hur många portioner?" })).toBeNull();
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
    // A network failure never reaches the DOM as raw text (#170) — it renders the
    // offline state (role "status", not "alert") instead.
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Anslut till internet och försök igen."));
    expect(screen.queryByText("network down")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Tillbaka" }));
    await screen.findByRole("heading", { name: "Vad har du hemma?" });
    expect(screen.queryByRole("button", { name: "ris" })).toBeNull();
  });
});
