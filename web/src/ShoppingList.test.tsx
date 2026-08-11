import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineShoppingList, ShoppingList, formatPortions } from "./ShoppingList";
import { loadShoppingList, SHOPPING_LIST_VERSION, type StoredShoppingList } from "./shoppingListStorage";
import type { IngredientAllergenMarking, TonightResult } from "./api";

// Component-level coverage for the shopping list, independent of the Tonight
// gate/suggestion flow (that wiring is covered in App.test.tsx). Two kinds of I/O
// happen here now: localStorage (the list's own state, unmocked — real jsdom
// storage, cleared every test) and the instructions fetch (mocked globally, since a
// real network call has no server to answer it in this environment).

function result(overrides: Partial<TonightResult> = {}): TonightResult {
  return {
    template: { id: "kycklinggryta", name: "Kycklinggryta", cost_tier: "mid", prep_time_band: "20-40min", cuisine: "swedish_nordic" },
    ingredients: [
      { role: "protein", name: "Kyckling", substituted: false, allergens: [], quantity: { kind: "amount", amount: 400, unit: "g" } },
      { role: "vegetable", name: "Morot", substituted: false, allergens: [], quantity: { kind: "amount", amount: 400, unit: "g" } },
    ],
    substitutions: [],
    score: 0.5,
    reasonCodes: [],
    cookedToday: false,
    ...overrides,
  };
}

/** A controllable stand-in for global fetch, deferred by default so tests that don't
 * care about instructions aren't racing an unresolved promise past cleanup. */
function mockFetch() {
  const fetchMock = vi.fn(() => new Promise<Response>(() => {})); // never resolves by default
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ShoppingList", () => {
  it("starts every ingredient in Att köpa", () => {
    mockFetch();
    render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Att köpa (2)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Har hemma (0)" })).toBeTruthy();
    expect(screen.getByText("Kyckling")).toBeTruthy();
    expect(screen.getByText("Morot")).toBeTruthy();
  });

  it("moving an item puts it in Har hemma and updates both counts", async () => {
    mockFetch();
    const user = userEvent.setup();
    render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

    const row = screen.getByText("Kyckling").closest("li")!;
    await user.click(row.querySelector("button")!);

    expect(screen.getByRole("heading", { name: "Att köpa (1)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Har hemma (1)" })).toBeTruthy();

    const homeSection = screen.getByRole("heading", { name: "Har hemma (1)" }).closest("section")!;
    expect(homeSection.textContent).toContain("Kyckling");
    // Moved out, not just checked — no checkbox on the Har hemma side.
    expect(homeSection.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it("checking an item marks it bought without moving it between sections", async () => {
    mockFetch();
    const user = userEvent.setup();
    render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

    const row = screen.getByText("Kyckling").closest("li")!;
    const checkbox = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await user.click(checkbox);

    expect(checkbox.checked).toBe(true);
    // Still in Att köpa — checking never moves a row between sections.
    expect(screen.getByRole("heading", { name: "Att köpa (2)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Har hemma (0)" })).toBeTruthy();

    const label = row.querySelector("label")!;
    expect(label.className).toContain("bought");
  });

  it("restores sections and check marks on remount (simulated reload)", async () => {
    mockFetch();
    const user = userEvent.setup();
    const { unmount } = render(
      <ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />,
    );

    await user.click(screen.getByText("Morot").closest("li")!.querySelector("button")!);
    await user.click(
      screen.getByText("Kyckling").closest("li")!.querySelector('input[type="checkbox"]')!,
    );
    unmount();

    render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Att köpa (1)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Har hemma (1)" })).toBeTruthy();
    const restoredCheckbox = screen
      .getByText("Kyckling")
      .closest("li")!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(restoredCheckbox.checked).toBe(true);
  });

  it("starts a fresh list for a different template id rather than merging", async () => {
    mockFetch();
    const user = userEvent.setup();
    const { unmount } = render(
      <ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />,
    );
    await user.click(screen.getByText("Morot").closest("li")!.querySelector("button")!);
    unmount();

    render(
      <ShoppingList
        result={result({
          template: { id: "fisksoppa", name: "Fisksoppa", cost_tier: "budget", prep_time_band: "<20min", cuisine: "swedish_nordic" },
          ingredients: [{ role: "protein", name: "Torsk", substituted: false, allergens: [], quantity: { kind: "amount", amount: 400, unit: "g" } }],
        })}
        portions={2}
        accessToken="tok"
        onNewSuggestion={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Att köpa (1)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Har hemma (0)" })).toBeTruthy();
    expect(screen.getByText("Torsk")).toBeTruthy();
    expect(screen.queryByText("Morot")).toBeNull();
  });

  it("clears the stored list and calls onNewSuggestion when Ny förslag is clicked", async () => {
    mockFetch();
    const user = userEvent.setup();
    const onNewSuggestion = vi.fn();
    render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={onNewSuggestion} />);

    await user.click(screen.getByRole("button", { name: "Ny förslag" }));

    expect(onNewSuggestion).toHaveBeenCalledTimes(1);
    expect(loadShoppingList("kycklinggryta")).toBeNull();
  });

  describe("allergen marking (#116)", () => {
    const mjolkAllergen: IngredientAllergenMarking = { allergy: "dairy_lactose", members: ["Elsa"] };

    it("marks an ingredient carrying a declared allergen, naming the allergen and the member", () => {
      mockFetch();
      render(
        <ShoppingList
          result={result({
            ingredients: [
              { role: "protein", name: "Kyckling", substituted: false, allergens: [], quantity: { kind: "amount", amount: 400, unit: "g" } },
              { role: "vegetable", name: "Morot", substituted: false, allergens: [mjolkAllergen], quantity: { kind: "amount", amount: 400, unit: "g" } },
            ],
          })}
          portions={2}
          accessToken="tok"
          onNewSuggestion={vi.fn()}
        />,
      );

      expect(screen.getByText("innehåller mjölk — Elsa")).toBeTruthy();
      // Not just colour: the row also carries the glyph as visible text content.
      const row = screen.getByText("Morot").closest("li")!;
      expect(row.textContent).toContain("⚠");
    });

    it("does not mark an ingredient with no allergens", () => {
      mockFetch();
      render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

      expect(screen.queryByText(/innehåller/)).toBeNull();
    });

    it("renders the marking after moving an item to Har hemma — display only, never a filter", async () => {
      mockFetch();
      const user = userEvent.setup();
      render(
        <ShoppingList
          result={result({
            ingredients: [{ role: "vegetable", name: "Morot", substituted: false, allergens: [mjolkAllergen], quantity: { kind: "amount", amount: 400, unit: "g" } }],
          })}
          portions={2}
          accessToken="tok"
          onNewSuggestion={vi.fn()}
        />,
      );

      await user.click(screen.getByText("Morot").closest("li")!.querySelector("button")!);

      expect(screen.getByText("innehåller mjölk — Elsa")).toBeTruthy();
    });

    it("survives a reload with the network offline, reading only from localStorage (UX_FLOW §7)", () => {
      const stored: StoredShoppingList = {
        version: SHOPPING_LIST_VERSION,
        templateId: "kycklinggryta",
        items: [
          { name: "Morot", section: "to_buy", bought: false, allergens: [mjolkAllergen], quantity: { kind: "amount", amount: 400, unit: "g" } },
        ],
      };

      render(<OfflineShoppingList list={stored} />);

      expect(screen.getByText("innehåller mjölk — Elsa")).toBeTruthy();
    });
  });

  // Amounts arrived with #123, so a row now legitimately contains digits. What the
  // original version of this guard was really protecting is untouched and asserted
  // here instead: no kronor figure ever reaches a row (CLAUDE.md — the app must never
  // show an invented cost). Quantities are curated data scaled deterministically; a
  // price is not.
  it("never renders a currency figure in an ingredient row", () => {
    mockFetch();
    render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

    for (const row of screen.getAllByRole("listitem")) {
      expect(row.textContent).not.toMatch(/\bkr\b|\bkronor\b|₤|SEK/i);
    }
  });

  // #123: the amounts are the reason the list is worth carrying into a shop.
  describe("scaled quantities", () => {
    it("renders the server-scaled amount before each ingredient, on both sections", async () => {
      mockFetch();
      const user = userEvent.setup();
      render(
        <ShoppingList
          result={result({
            ingredients: [
              {
                role: "protein",
                name: "Kyckling",
                substituted: false,
                allergens: [],
                quantity: { kind: "amount", amount: 450, unit: "g" },
              },
              {
                role: "dairy",
                name: "Matlagningsgrädde",
                substituted: false,
                allergens: [],
                quantity: { kind: "amount", amount: 1.5, unit: "dl" },
              },
            ],
          })}
          portions={3}
          accessToken="tok"
          onNewSuggestion={vi.fn()}
        />,
      );

      expect(screen.getByText("Kyckling").closest("li")!.textContent).toContain("450 g");
      // Swedish decimal comma, not a point.
      expect(screen.getByText("Matlagningsgrädde").closest("li")!.textContent).toContain("1,5 dl");

      // Still there after the row moves to "Har hemma" — the amount belongs to the
      // ingredient, not to the section it happens to sit in.
      await user.click(screen.getByText("Kyckling").closest("li")!.querySelector("button")!);
      expect(screen.getByText("Kyckling").closest("li")!.textContent).toContain("450 g");
    });

    it("renders 'efter smak' rather than a number for a to-taste slot", () => {
      mockFetch();
      render(
        <ShoppingList
          result={result({
            ingredients: [
              {
                role: "aromatic",
                name: "Svartpeppar",
                substituted: false,
                allergens: [],
                quantity: { kind: "to_taste" },
              },
            ],
          })}
          portions={4}
          accessToken="tok"
          onNewSuggestion={vi.fn()}
        />,
      );

      const row = screen.getByText("Svartpeppar").closest("li")!;
      expect(row.textContent).toContain("efter smak");
      expect(row.textContent).not.toMatch(/\d/);
    });

    it("shows the amount for a substituted slot — the slot's, carried by the server", () => {
      mockFetch();
      render(
        <ShoppingList
          result={result({
            ingredients: [
              {
                role: "dairy",
                name: "Havregrädde",
                substituted: true,
                allergens: [],
                quantity: { kind: "amount", amount: 2, unit: "dl" },
              },
            ],
          })}
          portions={4}
          accessToken="tok"
          onNewSuggestion={vi.fn()}
        />,
      );

      expect(screen.getByText("Havregrädde").closest("li")!.textContent).toContain("2 dl");
    });

    it("keeps the amount on a list re-opened offline from storage", () => {
      const stored: StoredShoppingList = {
        version: SHOPPING_LIST_VERSION,
        templateId: "kycklinggryta",
        items: [
          {
            name: "Morot",
            section: "to_buy",
            bought: false,
            allergens: [],
            quantity: { kind: "amount", amount: 300, unit: "g" },
          },
        ],
      };

      render(<OfflineShoppingList list={stored} />);

      expect(screen.getByText("Morot").closest("li")!.textContent).toContain("300 g");
    });
  });

  describe("instructions", () => {
    it("renders instructions when the fetch returns them, without blocking the shopping list", async () => {
      const fetchMock = mockFetch();
      let resolveFetch!: (response: Response) => void;
      fetchMock.mockImplementation(
        () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
      );
      const user = userEvent.setup();
      render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

      // Loading state, and the list itself is fully interactive while it's showing.
      expect(screen.getByText("Skapar instruktioner…")).toBeTruthy();
      const row = screen.getByText("Kyckling").closest("li")!;
      await user.click(row.querySelector("button")!);
      expect(screen.getByRole("heading", { name: "Har hemma (1)" })).toBeTruthy();

      await act(async () => {
        resolveFetch(jsonResponse({ instructions: ["Skär kycklingen.", "Stek i panna.", "Servera."] }));
      });

      await waitFor(() => expect(screen.queryByText("Skapar instruktioner…")).toBeNull());
      expect(screen.getByText("Skär kycklingen.")).toBeTruthy();
      expect(screen.getByText("Stek i panna.")).toBeTruthy();
      expect(screen.getByText("Servera.")).toBeTruthy();
    });

    it("renders the failure message and a retry control when instructions can't be generated", async () => {
      const fetchMock = mockFetch();
      fetchMock.mockResolvedValue(jsonResponse({ instructions: null, reason: "timeout" }));
      render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

      await waitFor(() =>
        expect(screen.getByText("Det gick inte att skapa instruktioner just nu.")).toBeTruthy(),
      );
      const retryButton = screen.getByRole("button", { name: "Försök igen" });
      expect(retryButton).toBeTruthy();

      // The shopping list stays interactive throughout the failure state too.
      const user = userEvent.setup();
      const checkbox = screen
        .getByText("Kyckling")
        .closest("li")!
        .querySelector('input[type="checkbox"]') as HTMLInputElement;
      await user.click(checkbox);
      expect(checkbox.checked).toBe(true);

      fetchMock.mockClear();
      await user.click(retryButton);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe("formatPortions", () => {
  it("renders a whole number with no decimal for an adults-only household (2 adults)", () => {
    expect(formatPortions(2)).toBe("För 2 portioner");
  });

  it("renders one decimal for a household including a child at portion_factor 0.5 (2 adults + 1 child)", () => {
    expect(formatPortions(2.5)).toBe("För 2.5 portioner");
  });
});
