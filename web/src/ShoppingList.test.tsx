import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineShoppingList, ShoppingList } from "./ShoppingList";
import { formatPortions } from "./display";
import { setAnalyticsSink } from "./analytics";
import {
  hasHouseholdWork,
  loadDisplacedShoppingList,
  loadShoppingList,
  saveShoppingList,
  SHOPPING_LIST_VERSION,
  type ShoppingListItem,
  type StoredShoppingList,
} from "./shoppingListStorage";
import type { TonightResult } from "./api";

// Component-level coverage for the shopping list, independent of the Tonight
// gate/suggestion flow (that wiring is covered in App.test.tsx). Two kinds of I/O
// happen here now: localStorage (the list's own state, unmocked — real jsdom
// storage, cleared every test) and the instructions fetch (mocked globally, since a
// real network call has no server to answer it in this environment).

function result(overrides: Partial<TonightResult> = {}): TonightResult {
  return {
    template: { id: "kycklinggryta", name: "Kycklinggryta", blurb: "Testblurb.", cost_tier: "mid", prep_time_band: "20-40min", effort_level: "moderate", cuisine: "swedish_nordic" },
    ingredients: [
      { role: "protein", name: "Kyckling", slotIndex: 0, ingredientId: "kyckling", substituted: false, quantity: { kind: "amount", amount: 400, unit: "g" } },
      { role: "vegetable", name: "Morot", slotIndex: 1, ingredientId: "morot", substituted: false, quantity: { kind: "amount", amount: 400, unit: "g" } },
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

  it("shows the explanation line when provided, and omits it when not", () => {
    mockFetch();
    const { unmount } = render(
      <ShoppingList
        result={result()}
        explanation="Valt för att ni har morot hemma."
        portions={2}
        accessToken="tok"
        onNewSuggestion={vi.fn()}
      />,
    );
    expect(screen.getByText("Valt för att ni har morot hemma.")).toBeTruthy();
    unmount();

    render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);
    expect(screen.queryByText("Valt för att ni har morot hemma.")).toBeNull();
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
          template: { id: "fisksoppa", name: "Fisksoppa", blurb: "Testblurb.", cost_tier: "budget", prep_time_band: "<20min", effort_level: "moderate", cuisine: "swedish_nordic" },
          ingredients: [{ role: "protein", name: "Torsk", slotIndex: 0, ingredientId: "torsk", substituted: false, quantity: { kind: "amount", amount: 400, unit: "g" } }],
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

  it("clears the stored list and calls onNewSuggestion when Nytt förslag is clicked", async () => {
    mockFetch();
    const user = userEvent.setup();
    const onNewSuggestion = vi.fn();
    render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={onNewSuggestion} />);

    await user.click(screen.getByRole("button", { name: "Nytt förslag" }));

    expect(onNewSuggestion).toHaveBeenCalledTimes(1);
    expect(loadShoppingList("kycklinggryta")).toBeNull();
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
                quantity: { kind: "amount", amount: 450, unit: "g" },
              },
              {
                role: "dairy",
                name: "Matlagningsgrädde",
                slotIndex: 1,
                ingredientId: "matlagningsgradde",
                substituted: false,
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
    it("makes 'Börja laga' the primary action and steps 'Nytt förslag' down", () => {
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
      expect(screen.getByRole("button", { name: "Nytt förslag" }).className).toContain("btn-secondary");
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

    it("omits the button, and keeps 'Nytt förslag' primary, when there is nothing to cook", () => {
      render(
        <ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />,
      );

      expect(screen.queryByRole("button", { name: "Börja laga" })).toBeNull();
      expect(screen.getByRole("button", { name: "Nytt förslag" }).className).toContain("btn-primary");
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

    function alternativesBody(overrides: Record<string, unknown> = {}) {
      return {
        substitutable: true,
        similar: [
          {
            ingredientId: "rodlok",
            name: "Rödlök",
            costTier: "budget",
            quantity: { kind: "amount", amount: 400, unit: "g" },
          },
        ],
        searchPool: [
          {
            ingredientId: "rodlok",
            name: "Rödlök",
            costTier: "budget",
            quantity: { kind: "amount", amount: 400, unit: "g" },
          },
          {
            ingredientId: "purjolok",
            name: "Purjolök",
            costTier: "budget",
            quantity: { kind: "amount", amount: 400, unit: "g" },
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

// #223: the variety note. Pantry coverage only *marks* a row — it never swaps the
// ingredient or rescales the amount — so on a "Har hemma" row this sentence is the
// only thing telling a household the dish will come out different.
describe("ShoppingList — variety notes", () => {
  const NOTE = "Fetthalten skiljer mellan sorterna — vispgrädde ger en tjockare sås.";

  function withNote() {
    return result({
      ingredients: [
        {
          role: "dairy",
          name: "matlagningsgrädde",
          slotIndex: 0,
          ingredientId: "matlagningsgradde",
          substituted: false,
          quantity: { kind: "amount", amount: 2, unit: "dl" },
          varietyNote: NOTE,
        },
        {
          role: "vegetable",
          name: "Morot",
          slotIndex: 1,
          ingredientId: "morot",
          substituted: false,
          quantity: { kind: "amount", amount: 400, unit: "g" },
        },
      ],
    });
  }

  it("renders the note on the row it belongs to, and on no other", () => {
    mockFetch();
    render(<ShoppingList result={withNote()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

    expect(screen.getAllByRole("note")).toHaveLength(1);
    expect(screen.getByRole("note").textContent).toBe(NOTE);
  });

  it("keeps the note visible after the row moves to Har hemma", () => {
    // The moment the note exists for: the household marked vispgrädde, the row is
    // now in the quiet half of the screen, and nothing else says the sauce changes.
    mockFetch();
    render(
      <ShoppingList
        result={withNote()}
        pantryIngredientIds={["matlagningsgradde"]}
        portions={2}
        accessToken="tok"
        onNewSuggestion={vi.fn()}
      />,
    );

    const haveAtHome = screen.getByText(/Har hemma \(/).closest("section")!;
    expect(within(haveAtHome).getByRole("note").textContent).toBe(NOTE);
  });

  it("renders no note at all when no row carries one", () => {
    mockFetch();
    render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

    expect(screen.queryByRole("note")).toBeNull();
  });

  it("survives a reload — the note is stored with the list, not re-fetched", () => {
    mockFetch();
    const { unmount } = render(
      <ShoppingList result={withNote()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />,
    );
    unmount();
    cleanup();

    // Second mount reads the stored list rather than the props' ingredients, which is
    // exactly the path a reload in the shop takes.
    render(<ShoppingList result={withNote()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

    expect(screen.getByRole("note").textContent).toBe(NOTE);
  });
});

// #202: a new dish used to destroy the previous list silently, including whatever the
// household had ticked, moved or swapped on it. The fix is an undo, not a confirm —
// see DECISION_LOG 2026-09-13 for why a prompt answered "yes" 95% of the time is worse
// than an offer that can be ignored.
describe("a displaced shopping list (#202)", () => {
  function item(overrides: Partial<ShoppingListItem> = {}): ShoppingListItem {
    return {
      name: "Kalops",
      section: "to_buy",
      bought: false,
      quantity: { kind: "amount", amount: 400, unit: "g" },
      slotIndex: 0,
      ingredientId: "notkott",
      ...overrides,
    };
  }

  function storedList(templateId: string, items: ShoppingListItem[]): StoredShoppingList {
    return { version: SHOPPING_LIST_VERSION, templateId, templateName: "Kalops med rotfrukter", items };
  }

  describe("hasHouseholdWork", () => {
    it("counts ticking, hand-moving and swapping as work worth keeping", () => {
      expect(hasHouseholdWork(storedList("kalops", [item({ bought: true })]))).toBe(true);
      expect(
        hasHouseholdWork(storedList("kalops", [item({ section: "have_at_home", movedByHand: true })])),
      ).toBe(true);
      expect(
        hasHouseholdWork(
          storedList("kalops", [
            item({ swappedFrom: { name: "Fläsk", ingredientId: "flask", bought: false, quantity: { kind: "amount", amount: 400, unit: "g" } } }),
          ]),
        ),
      ).toBe(true);
    });

    it("does not count a row the app placed in Har hemma", () => {
      // freshShoppingList opens `inPantry` rows there, and #200 moves rows there from
      // Tonight's pantry chips. Both are reproduced by accepting the dish again, so
      // neither is worth interrupting anyone over.
      expect(hasHouseholdWork(storedList("kalops", [item({ section: "have_at_home" })]))).toBe(false);
      expect(hasHouseholdWork(storedList("kalops", [item()]))).toBe(false);
    });
  });

  describe("saveShoppingList", () => {
    it("sets aside a list with work when a different dish takes its place", () => {
      saveShoppingList(storedList("kalops", [item({ bought: true })]));
      saveShoppingList(storedList("kycklinggryta", [item({ name: "Kyckling" })]));

      expect(loadDisplacedShoppingList()?.templateId).toBe("kalops");
      expect(loadShoppingList("kycklinggryta")?.templateId).toBe("kycklinggryta");
    });

    it("displaces nothing when the replaced list held no work of the household's own", () => {
      saveShoppingList(storedList("kalops", [item()]));
      saveShoppingList(storedList("kycklinggryta", [item({ name: "Kyckling" })]));

      expect(loadDisplacedShoppingList()).toBeNull();
    });

    it("treats saving over the same dish as a resume, not a displacement", () => {
      // The #200 path: accept, reroll, accept the same dish again. Offering to restore
      // a list nobody lost would be noise, and would do it on the common path.
      saveShoppingList(storedList("kalops", [item({ bought: true })]));
      saveShoppingList(storedList("kalops", [item({ bought: true }), item({ name: "Morot" })]));

      expect(loadDisplacedShoppingList()).toBeNull();
    });
  });

  it("offers the displaced list back, and hands off to the caller on Återställ", async () => {
    mockFetch();
    const user = userEvent.setup();
    const onRestored = vi.fn();
    saveShoppingList(storedList("kalops", [item({ bought: true })]));

    render(
      <ShoppingList result={result()} accessToken="t" onNewSuggestion={() => {}} onRestored={onRestored} />,
    );

    expect(await screen.findByText(/Din lista för Kalops med rotfrukter ersattes/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Återställ" }));

    expect(loadShoppingList("kalops")?.templateId).toBe("kalops");
    expect(loadDisplacedShoppingList()).toBeNull();
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  it("restores the list whole — the dish name and its swaps survive", async () => {
    // The restore hands off to /lista's resume path rather than rendering the list
    // here, precisely so `templateName` and `substitutions` are still on it afterwards.
    // Rendering it in place stripped both, and a cook screen opened from a stripped
    // list silently drops the household's ingredient swaps.
    mockFetch();
    const user = userEvent.setup();
    const withSwaps: StoredShoppingList = {
      version: SHOPPING_LIST_VERSION,
      templateId: "kalops",
      templateName: "Kalops med rotfrukter",
      substitutions: [{ slot_index: 0, substitute_ingredient_id: "flaskkarre" }],
      items: [item({ bought: true })],
    };
    saveShoppingList(withSwaps);

    render(
      <ShoppingList result={result()} accessToken="t" onNewSuggestion={() => {}} onRestored={() => {}} />,
    );
    await user.click(await screen.findByRole("button", { name: "Återställ" }));

    const restored = loadShoppingList("kalops");
    expect(restored?.templateName).toBe("Kalops med rotfrukter");
    expect(restored?.substitutions).toEqual([{ slot_index: 0, substitute_ingredient_id: "flaskkarre" }]);
  });

  it("survives a re-render after the restore instead of quietly undoing it", async () => {
    // The save effect re-runs whenever the parent hands down a new `substitutions`
    // array, which the resumed path rebuilds every render. If the restore left this
    // screen mounted, that re-run wrote the displacing dish back over the restored one.
    mockFetch();
    const user = userEvent.setup();
    saveShoppingList(storedList("kalops", [item({ bought: true })]));

    const { rerender } = render(
      <ShoppingList result={result()} accessToken="t" onNewSuggestion={() => {}} onRestored={() => {}} />,
    );
    await user.click(await screen.findByRole("button", { name: "Återställ" }));
    rerender(
      <ShoppingList result={result()} accessToken="t" onNewSuggestion={() => {}} onRestored={() => {}} />,
    );

    expect(loadShoppingList("kalops")?.templateId).toBe("kalops");
    expect(loadDisplacedShoppingList()).toBeNull();
  });

  it("reports the replacement once, not once per visit to the list", async () => {
    // The restore rate is the whole point of the event pair, and re-announcing the same
    // displacement on every remount inflates its denominator — biasing the answer
    // toward "restores are rare", which is the conclusion that stops multi-dish lists.
    const events: { name: string }[] = [];
    setAnalyticsSink((event) => events.push(event));
    mockFetch();
    saveShoppingList(storedList("kalops", [item({ bought: true })]));

    const first = render(<ShoppingList result={result()} accessToken="t" onNewSuggestion={() => {}} />);
    await screen.findByText(/ersattes/);
    first.unmount();
    render(<ShoppingList result={result()} accessToken="t" onNewSuggestion={() => {}} />);
    await screen.findByText(/ersattes/);

    expect(events.filter((event) => event.name === "shopping_list_replaced")).toHaveLength(1);
    setAnalyticsSink(null);
  });

  it("keeps the offer reachable when the replacing dish already had work on it", async () => {
    // The case where the most was lost: the household had lists for both dishes. An
    // effect watching `items` retired the offer in the same commit that made it,
    // because the resumed list arrived already ticked.
    mockFetch();
    saveShoppingList({
      version: SHOPPING_LIST_VERSION,
      templateId: "kycklinggryta",
      items: [item({ name: "Kyckling", bought: true })],
    });
    saveShoppingList(storedList("kalops", [item({ bought: true })]));

    render(<ShoppingList result={result()} accessToken="t" onNewSuggestion={() => {}} />);

    expect(await screen.findByRole("button", { name: "Återställ" })).toBeTruthy();
  });

  it("retires the offer when dismissed, and does not bring it back on a re-render", async () => {
    mockFetch();
    const user = userEvent.setup();
    saveShoppingList(storedList("kalops", [item({ bought: true })]));

    render(<ShoppingList result={result()} accessToken="t" onNewSuggestion={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Avfärda" }));

    expect(loadDisplacedShoppingList()).toBeNull();
    expect(screen.queryByText(/ersattes/)).toBeNull();
  });

  it("retires the offer once the new list has work of its own", async () => {
    mockFetch();
    const user = userEvent.setup();
    saveShoppingList(storedList("kalops", [item({ bought: true })]));

    render(<ShoppingList result={result()} accessToken="t" onNewSuggestion={() => {}} />);
    expect(await screen.findByText(/ersattes/)).toBeTruthy();

    // The household has moved on: an undo bar pointing backwards over a list they are
    // already working on is clutter.
    await user.click(screen.getAllByRole("checkbox")[0]!);

    expect(screen.queryByText(/ersattes/)).toBeNull();
    expect(loadDisplacedShoppingList()).toBeNull();
  });

  it("drops the offer when the household abandons the list context entirely", async () => {
    // "Nytt förslag" clears the list and the offer attached to it. Asserted rather than
    // left implicit because `clearShoppingList` clearing a second key is exactly the
    // kind of coupling that reads as a bug later — it is deliberate, and this says so.
    mockFetch();
    const user = userEvent.setup();
    saveShoppingList(storedList("kalops", [item({ bought: true })]));

    render(<ShoppingList result={result()} accessToken="t" onNewSuggestion={() => {}} />);
    await screen.findByText(/ersattes/);
    await user.click(screen.getByRole("button", { name: "Nytt förslag" }));

    expect(loadDisplacedShoppingList()).toBeNull();
    expect(loadShoppingList("kycklinggryta")).toBeNull();
  });

  it("shows no offer at all when nothing was displaced", async () => {
    mockFetch();
    render(<ShoppingList result={result()} accessToken="t" onNewSuggestion={() => {}} />);

    await screen.findByText("Kyckling");
    expect(screen.queryByText(/ersattes/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Återställ" })).toBeNull();
  });
});
