import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineShoppingList, ShoppingList } from "./ShoppingList";
import { formatPortions } from "./display";
import { loadShoppingList, SHOPPING_LIST_VERSION, type StoredShoppingList } from "./shoppingListStorage";
import type { IngredientAllergenMarking, TonightResult } from "./api";

// Component-level coverage for the shopping list, independent of the Tonight
// gate/suggestion flow (that wiring is covered in App.test.tsx). Two kinds of I/O
// happen here now: localStorage (the list's own state, unmocked — real jsdom
// storage, cleared every test) and the instructions fetch (mocked globally, since a
// real network call has no server to answer it in this environment).

function result(overrides: Partial<TonightResult> = {}): TonightResult {
  return {
    template: { id: "kycklinggryta", name: "Kycklinggryta", blurb: "Testblurb.", cost_tier: "mid", prep_time_band: "20-40min", cuisine: "swedish_nordic" },
    ingredients: [
      { role: "protein", name: "Kyckling", slotIndex: 0, ingredientId: "kyckling", substituted: false, allergens: [], quantity: { kind: "amount", amount: 400, unit: "g" } },
      { role: "vegetable", name: "Morot", slotIndex: 1, ingredientId: "morot", substituted: false, allergens: [], quantity: { kind: "amount", amount: 400, unit: "g" } },
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

/**
 * A fetch stand-in that answers `/api/ingredients/alternatives` with `body` and
 * leaves every other call (instructions) unresolved — the popover's own fetch is
 * what these tests exercise, and the instructions panel underneath it is
 * deliberately never awaited.
 */
function mockAlternativesFetch(body: unknown) {
  const fetchMock = vi.fn((url: string) => {
    if (typeof url === "string" && url.startsWith("/api/ingredients/alternatives")) {
      return Promise.resolve(jsonResponse(body));
    }
    return new Promise<Response>(() => {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ShoppingList", () => {
  it("starts every ingredient in Behöver handlas", () => {
    mockFetch();
    render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Behöver handlas (2)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Har hemma (0)" })).toBeTruthy();
    expect(screen.getByText("Kyckling")).toBeTruthy();
    expect(screen.getByText("Morot")).toBeTruthy();
  });

  it("moving an item puts it in Har hemma and updates both counts", async () => {
    mockFetch();
    const user = userEvent.setup();
    render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

    const row = screen.getByText("Kyckling").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Har hemma" }));

    expect(screen.getByRole("heading", { name: "Behöver handlas (1)" })).toBeTruthy();
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
    // Still in Behöver handlas — checking never moves a row between sections.
    expect(screen.getByRole("heading", { name: "Behöver handlas (2)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Har hemma (0)" })).toBeTruthy();

    // The bought styling lives on the ingredient tap target (#124), not the checkbox
    // label — the label now wraps only the checkbox.
    const tapTarget = screen.getByRole("button", { name: /Kyckling/ });
    expect(tapTarget.className).toContain("bought");
  });

  it("restores sections and check marks on remount (simulated reload)", async () => {
    mockFetch();
    const user = userEvent.setup();
    const { unmount } = render(
      <ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />,
    );

    await user.click(within(screen.getByText("Morot").closest("li")!).getByRole("button", { name: "Har hemma" }));
    await user.click(
      screen.getByText("Kyckling").closest("li")!.querySelector('input[type="checkbox"]')!,
    );
    unmount();

    render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Behöver handlas (1)" })).toBeTruthy();
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
    await user.click(within(screen.getByText("Morot").closest("li")!).getByRole("button", { name: "Har hemma" }));
    unmount();

    render(
      <ShoppingList
        result={result({
          template: { id: "fisksoppa", name: "Fisksoppa", blurb: "Testblurb.", cost_tier: "budget", prep_time_band: "<20min", cuisine: "swedish_nordic" },
          ingredients: [{ role: "protein", name: "Torsk", slotIndex: 0, ingredientId: "torsk", substituted: false, allergens: [], quantity: { kind: "amount", amount: 400, unit: "g" } }],
        })}
        portions={2}
        accessToken="tok"
        onNewSuggestion={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Behöver handlas (1)" })).toBeTruthy();
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
              { role: "protein", name: "Kyckling", slotIndex: 0, ingredientId: "kyckling", substituted: false, allergens: [], quantity: { kind: "amount", amount: 400, unit: "g" } },
              { role: "vegetable", name: "Morot", slotIndex: 1, ingredientId: "morot", substituted: false, allergens: [mjolkAllergen], quantity: { kind: "amount", amount: 400, unit: "g" } },
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
            ingredients: [{ role: "vegetable", name: "Morot", slotIndex: 0, ingredientId: "morot", substituted: false, allergens: [mjolkAllergen], quantity: { kind: "amount", amount: 400, unit: "g" } }],
          })}
          portions={2}
          accessToken="tok"
          onNewSuggestion={vi.fn()}
        />,
      );

      await user.click(within(screen.getByText("Morot").closest("li")!).getByRole("button", { name: "Har hemma" }));

      expect(screen.getByText("innehåller mjölk — Elsa")).toBeTruthy();
    });

    it("survives a reload with the network offline, reading only from localStorage (UX_FLOW §7)", () => {
      const stored: StoredShoppingList = {
        version: SHOPPING_LIST_VERSION,
        templateId: "kycklinggryta",
        items: [
          { name: "Morot", section: "to_buy", bought: false, allergens: [mjolkAllergen], quantity: { kind: "amount", amount: 400, unit: "g" }, slotIndex: 0, ingredientId: "morot" },
        ],
      };

      render(<OfflineShoppingList list={stored} />);

      expect(screen.getByText("innehåller mjölk — Elsa")).toBeTruthy();
    });

    // Exhaustive, not a sample: every ingredient carrying a declared allergen must
    // show its own marking, and every ingredient that doesn't must show none — for
    // every ingredient in the list, in both sections, checked one by one rather than
    // spot-checked (#139 requirement).
    it("marks every allergen-carrying ingredient and none of the rest, across both sections", () => {
      mockFetch();
      const glutenAllergen: IngredientAllergenMarking = { allergy: "gluten", members: ["Sam"] };
      const nutAllergen: IngredientAllergenMarking = { allergy: "tree_nuts", members: ["Elsa", "Sam"] };

      render(
        <ShoppingList
          result={result({
            ingredients: [
              { role: "protein", name: "Kyckling", slotIndex: 0, ingredientId: "kyckling", substituted: false, allergens: [], quantity: { kind: "amount", amount: 400, unit: "g" } },
              { role: "vegetable", name: "Morot", slotIndex: 1, ingredientId: "morot", substituted: false, allergens: [mjolkAllergen], quantity: { kind: "amount", amount: 400, unit: "g" } },
              { role: "starch", name: "Pasta", slotIndex: 2, ingredientId: "pasta", substituted: false, allergens: [glutenAllergen], quantity: { kind: "amount", amount: 300, unit: "g" } },
              { role: "dairy", name: "Mandlar", slotIndex: 3, ingredientId: "mandlar", substituted: false, allergens: [nutAllergen], quantity: { kind: "amount", amount: 50, unit: "g" } },
              { role: "aromatic", name: "Salt", slotIndex: 4, ingredientId: "salt", substituted: false, allergens: [], quantity: { kind: "to_taste" } },
            ],
          })}
          portions={2}
          accessToken="tok"
          onNewSuggestion={vi.fn()}
        />,
      );

      const expectations: Array<{ name: string; text: string | null }> = [
        { name: "Kyckling", text: null },
        { name: "Morot", text: "innehåller mjölk — Elsa" },
        { name: "Pasta", text: "innehåller gluten — Sam" },
        { name: "Mandlar", text: "innehåller trädnötter — Elsa och Sam" },
        { name: "Salt", text: null },
      ];

      for (const { name, text } of expectations) {
        const row = screen.getByText(name).closest("li")!;
        if (text === null) {
          expect(within(row).queryByText(/innehåller/)).toBeNull();
          expect(row.textContent).not.toContain("⚠");
        } else {
          expect(within(row).getByText(text)).toBeTruthy();
          expect(row.textContent).toContain("⚠");
        }
      }
    });

    it("marks every allergen-carrying ingredient and none of the rest in the offline variant", () => {
      const glutenAllergen: IngredientAllergenMarking = { allergy: "gluten", members: ["Sam"] };

      const stored: StoredShoppingList = {
        version: SHOPPING_LIST_VERSION,
        templateId: "kycklinggryta",
        items: [
          { name: "Kyckling", section: "to_buy", bought: false, allergens: [], quantity: { kind: "amount", amount: 400, unit: "g" }, slotIndex: 0, ingredientId: "kyckling" },
          { name: "Morot", section: "to_buy", bought: false, allergens: [mjolkAllergen], quantity: { kind: "amount", amount: 400, unit: "g" }, slotIndex: 1, ingredientId: "morot" },
          { name: "Pasta", section: "have_at_home", bought: false, allergens: [glutenAllergen], quantity: { kind: "amount", amount: 300, unit: "g" }, slotIndex: 2, ingredientId: "pasta" },
        ],
      };

      render(<OfflineShoppingList list={stored} />);

      const expectations: Array<{ name: string; text: string | null }> = [
        { name: "Kyckling", text: null },
        { name: "Morot", text: "innehåller mjölk — Elsa" },
        { name: "Pasta", text: "innehåller gluten — Sam" },
      ];

      for (const { name, text } of expectations) {
        const row = screen.getByText(name).closest("li")!;
        if (text === null) {
          expect(within(row).queryByText(/innehåller/)).toBeNull();
          expect(row.textContent).not.toContain("⚠");
        } else {
          expect(within(row).getByText(text)).toBeTruthy();
          expect(row.textContent).toContain("⚠");
        }
      }
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
                slotIndex: 0,
                ingredientId: "kyckling",
                substituted: false,
                allergens: [],
                quantity: { kind: "amount", amount: 450, unit: "g" },
              },
              {
                role: "dairy",
                name: "Matlagningsgrädde",
                slotIndex: 1,
                ingredientId: "matlagningsgradde",
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
      await user.click(within(screen.getByText("Kyckling").closest("li")!).getByRole("button", { name: "Har hemma" }));
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
                slotIndex: 0,
                ingredientId: "svartpeppar",
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

    it("names the substitute, not the ingredient the template originally called for", () => {
      // Moved here from the Tonight card (#183), which used to be where a household
      // could see that a swap had happened. Tonight no longer lists ingredients at
      // all — this screen is where the claim now has to hold, and it is the screen
      // where it actually matters, because this is the list you shop from.
      mockFetch();
      render(
        <ShoppingList
          result={result({
            ingredients: [
              {
                role: "dairy",
                name: "Havregrädde",
                slotIndex: 0,
                ingredientId: "havregradde",
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

      expect(screen.getByText("Havregrädde")).toBeTruthy();
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
                slotIndex: 0,
                ingredientId: "havregradde",
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
            slotIndex: 0,
            ingredientId: "morot",
          },
        ],
      };

      render(<OfflineShoppingList list={stored} />);

      expect(screen.getByText("Morot").closest("li")!.textContent).toContain("300 g");
    });
  });

  describe("cooking", () => {
    it("makes 'Börja laga' the primary action and steps 'Ny förslag' down", () => {
      const onCook = vi.fn();
      render(
        <ShoppingList
          result={result()}
          portions={2}
          accessToken="tok"
          onNewSuggestion={vi.fn()}
          onCook={onCook}
        />,
      );

      expect(screen.getByRole("button", { name: "Börja laga" }).className).toContain("btn-primary");
      expect(screen.getByRole("button", { name: "Ny förslag" }).className).toContain("btn-secondary");
    });

    it("opens the cook screen", async () => {
      const onCook = vi.fn();
      render(
        <ShoppingList
          result={result()}
          portions={2}
          accessToken="tok"
          onNewSuggestion={vi.fn()}
          onCook={onCook}
        />,
      );

      await userEvent.click(screen.getByRole("button", { name: "Börja laga" }));
      expect(onCook).toHaveBeenCalled();
    });

    it("omits the button, and keeps 'Ny förslag' primary, when there is nothing to cook", () => {
      render(
        <ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />,
      );

      expect(screen.queryByRole("button", { name: "Börja laga" })).toBeNull();
      expect(screen.getByRole("button", { name: "Ny förslag" }).className).toContain("btn-primary");
    });

    // The instructions moved to /laga/:id (#154) — one surface owns them, and this
    // screen must not quietly grow a second copy back.
    it("does not render instructions itself", () => {
      const fetchMock = mockFetch();
      render(
        <ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />,
      );

      expect(screen.queryByText("Skapar instruktioner…")).toBeNull();
      expect(screen.queryByText("Så här gör du")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // #124: tapping an ingredient opens the swap popover.
  describe("ingredient swap popover", () => {
    const rodlok: IngredientAllergenMarking[] = [];

    function alternativesBody(overrides: Record<string, unknown> = {}) {
      return {
        substitutable: true,
        similar: [
          {
            ingredientId: "rodlok",
            name: "Rödlök",
            costTier: "budget",
            quantity: { kind: "amount", amount: 400, unit: "g" },
            allergens: rodlok,
          },
        ],
        searchPool: [
          {
            ingredientId: "rodlok",
            name: "Rödlök",
            costTier: "budget",
            quantity: { kind: "amount", amount: 400, unit: "g" },
            allergens: rodlok,
          },
          {
            ingredientId: "purjolok",
            name: "Purjolök",
            costTier: "budget",
            quantity: { kind: "amount", amount: 400, unit: "g" },
            allergens: rodlok,
          },
        ],
        ...overrides,
      };
    }

    it("opens on tap, fetches once, and shows the curated alternatives", async () => {
      const fetchMock = mockAlternativesFetch(alternativesBody());
      const user = userEvent.setup();
      render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: /Kyckling/ }));

      expect(await screen.findByRole("dialog", { name: "Byt ut Kyckling" })).toBeTruthy();
      expect(screen.getByRole("button", { name: /Liknande/ })).toBeTruthy();
      // Billigare has no data behind it in this fixture — omitted, not empty.
      expect(screen.queryByRole("button", { name: /Billigare/ })).toBeNull();
      expect(screen.getByRole("button", { name: /Rödlök/ })).toBeTruthy();

      const alternativesCalls = fetchMock.mock.calls.filter(([url]) =>
        typeof url === "string" ? url.startsWith("/api/ingredients/alternatives") : false,
      );
      expect(alternativesCalls).toHaveLength(1);
      expect(alternativesCalls[0]![0]).toContain("slot=0");
      expect(alternativesCalls[0]![0]).toContain("ingredient=kyckling");
    });

    it("says plainly that a non-substitutable slot offers nothing", async () => {
      mockAlternativesFetch({ substitutable: false });
      const user = userEvent.setup();
      render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: /Kyckling/ }));

      expect(await screen.findByText("Den här ingrediensen är rätten i sig — inget att byta ut.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Liknande/ })).toBeNull();
      expect(screen.queryByLabelText("Sök alternativ")).toBeNull();
    });

    it("filters the search pool client-side by typed query, without a second fetch", async () => {
      const fetchMock = mockAlternativesFetch(alternativesBody());
      const user = userEvent.setup();
      render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: /Kyckling/ }));
      await user.type(await screen.findByLabelText("Sök alternativ"), "purjo");

      expect(screen.getByRole("button", { name: /Purjolök/ })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Rödlök/ })).toBeNull();

      const alternativesCalls = fetchMock.mock.calls.filter(([url]) =>
        typeof url === "string" ? url.startsWith("/api/ingredients/alternatives") : false,
      );
      expect(alternativesCalls).toHaveLength(1);
    });

    it("applies a swap: replaces the item in place, keeps its section, and marks it as changed", async () => {
      mockAlternativesFetch(alternativesBody());
      const user = userEvent.setup();
      render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: /Kyckling/ }));
      await user.click(await screen.findByRole("button", { name: /Rödlök/ }));

      // Popover closes on apply.
      expect(screen.queryByRole("dialog")).toBeNull();
      // Still in Behöver handlas (2) — a swap updates the row, it does not move it.
      expect(screen.getByRole("heading", { name: "Behöver handlas (2)" })).toBeTruthy();
      expect(screen.queryByText("Kyckling")).toBeNull();
      const row = screen.getByText("Rödlök").closest("li")!;
      expect(row.textContent).toContain("bytt");
      expect(within(row).getByRole("button", { name: "Ångra bytet" })).toBeTruthy();
    });

    it("undoes a swap in one tap, restoring the original ingredient", async () => {
      mockAlternativesFetch(alternativesBody());
      const user = userEvent.setup();
      render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: /Kyckling/ }));
      await user.click(await screen.findByRole("button", { name: /Rödlök/ }));

      const row = screen.getByText("Rödlök").closest("li")!;
      await user.click(within(row).getByRole("button", { name: "Ångra bytet" }));

      expect(screen.getByText("Kyckling")).toBeTruthy();
      expect(screen.queryByText("Rödlök")).toBeNull();
      expect(screen.queryByRole("button", { name: "Ångra bytet" })).toBeNull();
    });

    it("undo restores a checked item's bought state too, not just its name", async () => {
      mockAlternativesFetch(alternativesBody());
      const user = userEvent.setup();
      render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

      const kycklingRow = screen.getByText("Kyckling").closest("li")!;
      await user.click(within(kycklingRow).getByRole("checkbox"));
      expect((within(kycklingRow).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);

      await user.click(screen.getByRole("button", { name: /Kyckling/ }));
      await user.click(await screen.findByRole("button", { name: /Rödlök/ }));

      // Swapping resets bought — a checkmark against the old ingredient means
      // nothing once the row names a different one.
      const swappedRow = screen.getByText("Rödlök").closest("li")!;
      expect((within(swappedRow).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);

      await user.click(within(swappedRow).getByRole("button", { name: "Ångra bytet" }));

      const restoredRow = screen.getByText("Kyckling").closest("li")!;
      expect((within(restoredRow).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    });

    it("forwards the shopping list's diner selection to the alternatives request", async () => {
      const fetchMock = mockAlternativesFetch(alternativesBody());
      const user = userEvent.setup();
      render(
        <ShoppingList
          result={result()}
          portions={2}
          diners="0,1"
          accessToken="tok"
          onNewSuggestion={vi.fn()}
        />,
      );

      await user.click(screen.getByRole("button", { name: /Kyckling/ }));
      await screen.findByRole("dialog");

      const alternativesCalls = fetchMock.mock.calls.filter(([url]) =>
        typeof url === "string" ? url.startsWith("/api/ingredients/alternatives") : false,
      );
      expect(alternativesCalls).toHaveLength(1);
      expect(alternativesCalls[0]![0]).toContain("diners=0%2C1");
    });

    it("closes on outside tap (the backdrop) without applying anything", async () => {
      mockAlternativesFetch(alternativesBody());
      const user = userEvent.setup();
      render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: /Kyckling/ }));
      const dialog = await screen.findByRole("dialog");

      // The backdrop is the dialog's own parent — clicking it, not the dialog itself.
      await user.click(dialog.parentElement!);

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByText("Kyckling")).toBeTruthy();
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
