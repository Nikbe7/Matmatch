import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CookScreen, CookScreenEmpty, type CookMeal } from "./CookScreen";
import { loadCookRecord, saveCookRecord, substitutionKey } from "./instructionsStorage";
import { formatPortions } from "./display";

// Component-level coverage for the cook screen (#154). Two kinds of I/O: the
// instructions fetch (mocked — no server in this environment) and localStorage (real
// jsdom storage, cleared every test, because the offline behaviour under test *is*
// the storage behaviour).

function meal(overrides: Partial<CookMeal> = {}): CookMeal {
  return {
    templateId: "kycklinggryta",
    name: "Kycklinggryta",
    prepTimeBand: "20-40min",
    portions: 2.7,
    ingredients: [
      { name: "Kycklingfilé", quantity: { kind: "amount", amount: 400, unit: "g" } },
      { name: "Morot", quantity: { kind: "amount", amount: 200, unit: "g" } },
      { name: "Salt", quantity: { kind: "to_taste" } },
    ],
    substitutions: [],
    ...overrides,
  };
}

const STEPS = [
  "Skär kycklingfilén i bitar.",
  "Skala och tärna moroten.",
  "Hetta upp en stekpanna.",
  "Bryn kycklingen på hög värme.",
  "Tillsätt moroten och fräs kort.",
  "Låt allt sjuda tills kycklingen är genomstekt.",
];

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return { ok: init.ok ?? true, status: init.status ?? 200, json: async () => body } as Response;
}

/** Never resolves — holds the screen in its "generating" state for as long as a test
 *  needs to look at it. */
function pendingFetch() {
  const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function resolvingFetch(body: unknown) {
  const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(body)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A network failure that never reached the server — what `fetch` does with no
 *  connection, and what `presentError` reads as "offline". */
function offlineFetch() {
  const fetchMock = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderCook(props: Partial<Parameters<typeof CookScreen>[0]> = {}) {
  return render(
    <CookScreen
      meal={meal()}
      accessToken="token"
      onBack={props.onBack ?? (() => {})}
      onShoppingList={props.onShoppingList ?? (() => {})}
      {...props}
    />,
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the four states", () => {
  it("generating: says so, and shows the dish and ingredients meanwhile", async () => {
    pendingFetch();
    renderCook();

    expect(await screen.findByText("Skapar instruktioner…")).toBeTruthy();
    // The dish is known before the model answers — nothing above the steps depends
    // on the generation, so a slow first call never leaves an empty screen.
    expect(screen.getByText("Kycklinggryta")).toBeTruthy();
    expect(screen.getByText("Kycklingfilé")).toBeTruthy();
    expect(screen.getByText("400 g")).toBeTruthy();
  });

  it("cached: renders stored steps immediately, without any fetch", async () => {
    const fetchMock = pendingFetch();
    saveCookRecord({
      version: 1,
      templateId: "kycklinggryta",
      substitutionKey: substitutionKey([]),
      substitutions: [],
      name: "Kycklinggryta",
      prepTimeBand: "20-40min",
      ingredients: meal().ingredients,
      steps: STEPS,
    });

    renderCook();

    expect(screen.getByText(STEPS[0]!)).toBeTruthy();
    expect(screen.queryByText("Skapar instruktioner…")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("error: offers a retry that calls the endpoint again", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ instructions: null, reason: "api_error" })));
    vi.stubGlobal("fetch", fetchMock);
    renderCook();

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Försök igen" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("offline with nothing stored: says there is no connection, does not pretend to retry", async () => {
    offlineFetch();
    renderCook();

    expect(await screen.findByText(/Ingen anslutning/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Försök igen" })).toBeNull();
  });

  it("offline after one successful visit: the steps are still there", async () => {
    const fetchMock = resolvingFetch({ instructions: STEPS });
    const { unmount } = renderCook();
    await screen.findByText(STEPS[0]!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();
    cleanup();

    // Second visit, no connection at all: the screen must be fully usable, which is
    // the entire point of persisting the record (sw.ts never caches /api/*).
    const offline = offlineFetch();
    renderCook();

    expect(screen.getByText(STEPS[0]!)).toBeTruthy();
    expect(screen.getByText(STEPS[5]!)).toBeTruthy();
    expect(offline).not.toHaveBeenCalled();
  });
});

describe("persistence", () => {
  it("stores the steps and the dish alongside them after a successful generation", async () => {
    resolvingFetch({ instructions: STEPS });
    renderCook();
    await screen.findByText(STEPS[0]!);

    await waitFor(() => {
      const stored = loadCookRecord("kycklinggryta", []);
      expect(stored?.steps).toEqual(STEPS);
      expect(stored?.name).toBe("Kycklinggryta");
      expect(stored?.prepTimeBand).toBe("20-40min");
    });
  });

  it("keeps two substitution sets apart", async () => {
    resolvingFetch({ instructions: STEPS });
    const swapped = [{ slot_index: 0, substitute_ingredient_id: "tofu" }];
    render(
      <CookScreen
        meal={meal({ substitutions: swapped })}
        accessToken="token"
        onBack={() => {}}
        onShoppingList={() => {}}
      />,
    );
    await screen.findByText(STEPS[0]!);

    await waitFor(() => expect(loadCookRecord("kycklinggryta", swapped)?.steps).toEqual(STEPS));
    // The un-swapped dish is a different recipe and must not be served these steps.
    expect(loadCookRecord("kycklinggryta", [])).toBeNull();
  });

  it("does not store anything when generation failed", async () => {
    resolvingFetch({ instructions: null, reason: "validation_failed" });
    renderCook();
    await screen.findByRole("alert");

    expect(loadCookRecord("kycklinggryta", [])).toBeNull();
  });
});

describe("one step at a time", () => {
  it("advances through the steps and ends with a way out", async () => {
    resolvingFetch({ instructions: STEPS });
    const onBack = vi.fn();
    renderCook({ onBack });
    await screen.findByText(STEPS[0]!);

    expect(screen.getByRole("button", { name: "Klar med steg 1" })).toBeTruthy();

    for (let step = 1; step < STEPS.length; step++) {
      await userEvent.click(screen.getByRole("button", { name: `Klar med steg ${step}` }));
    }

    const done = screen.getByRole("button", { name: "Middagen är klar" });
    await userEvent.click(done);
    expect(onBack).toHaveBeenCalled();
  });

  it("marks exactly one step as current, and follows a tap on another", async () => {
    resolvingFetch({ instructions: STEPS });
    renderCook();
    await screen.findByText(STEPS[0]!);

    expect(screen.getAllByRole("button", { current: "step" })).toHaveLength(1);

    await userEvent.click(screen.getByText(STEPS[3]!));
    const current = screen.getAllByRole("button", { current: "step" });
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toContain(STEPS[3]);
  });
});

describe("numbers on this screen", () => {
  /**
   * The load-bearing test for the AI/engine boundary on this surface (#154). The
   * steps below all mention minute counts; the template's curated band says
   * "<20min". The metadata row must report the curated band and nothing else — not
   * the largest number in the prose, not the sum of them, not an estimate derived
   * from them.
   */
  it("takes the time from the curated prep-time band, never from the steps", async () => {
    const timedSteps = [
      "Koka riset i 45 minuter.",
      "Bryn kycklingen i 12 minuter.",
      "Låt sjuda 30 minuter.",
      "Vila 15 minuter.",
      "Rör om i 5 minuter.",
      "Servera efter 8 minuter.",
    ];
    resolvingFetch({ instructions: timedSteps });
    render(
      <CookScreen
        meal={meal({ prepTimeBand: "<20min" })}
        accessToken="token"
        onBack={() => {}}
        onShoppingList={() => {}}
      />,
    );
    await screen.findByText(timedSteps[0]!);

    const metaRow = screen.getByText("Under 20 min");
    expect(metaRow).toBeTruthy();

    // 115 minutes is the sum, 45 the largest single figure — neither may appear as a
    // time anywhere outside the step prose itself.
    const meta = metaRow.closest("p")!;
    expect(meta.textContent).toContain("Under 20 min");
    expect(meta.textContent).not.toMatch(/115|45|min(?!$)utes/);
  });

  it("omits the time entirely when no curated band is in hand", async () => {
    resolvingFetch({ instructions: STEPS });
    render(
      <CookScreen
        meal={meal({ prepTimeBand: undefined })}
        accessToken="token"
        onBack={() => {}}
        onShoppingList={() => {}}
      />,
    );
    await screen.findByText(STEPS[0]!);

    // Guessing is not an option: a resumed dish with no band shows portions alone.
    expect(screen.queryByText(/min/)).toBeNull();
    expect(screen.getByText(formatPortions(2.7))).toBeTruthy();
  });

  it("renders amounts from the engine-scaled quantities, including to_taste", async () => {
    resolvingFetch({ instructions: STEPS });
    renderCook();
    await screen.findByText(STEPS[0]!);

    expect(screen.getByText("400 g")).toBeTruthy();
    expect(screen.getByText("200 g")).toBeTruthy();
    expect(screen.getByText("efter smak")).toBeTruthy();
  });
});

describe("CookScreenEmpty", () => {
  it("offers one way back", async () => {
    const onBack = vi.fn();
    render(<CookScreenEmpty onBack={onBack} />);

    await userEvent.click(screen.getByRole("button", { name: "Se förslag för ikväll" }));
    expect(onBack).toHaveBeenCalled();
  });
});

// #223: the variety note at the stove. The shop and the pan are hours apart, and the
// pan is where "vispgrädde instead of matlagningsgrädde" actually changes the sauce.
describe("CookScreen — variety notes", () => {
  const NOTE = "Fetthalten skiljer mellan sorterna — vispgrädde ger en tjockare sås.";

  it("shows the note on the ingredient row that carries one", async () => {
    resolvingFetch({ instructions: STEPS });
    renderCook({
      meal: meal({
        ingredients: [
          {
            name: "matlagningsgrädde",
            quantity: { kind: "amount", amount: 2, unit: "dl" },
            varietyNote: NOTE,
          },
          { name: "Morot", quantity: { kind: "amount", amount: 200, unit: "g" } },
        ],
      }),
    });
    await screen.findByText(STEPS[0]!);

    expect(screen.getByRole("note").textContent).toBe(NOTE);
  });

  it("shows no note when no ingredient carries one", async () => {
    resolvingFetch({ instructions: STEPS });
    renderCook();
    await screen.findByText(STEPS[0]!);

    expect(screen.queryByRole("note")).toBeNull();
  });
});
