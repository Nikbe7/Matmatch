import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShoppingList, formatPortions } from "./ShoppingList";
import { loadShoppingList } from "./shoppingListStorage";
import type { TonightResult } from "./api";

// Component-level coverage for the shopping list, independent of the Tonight
// gate/suggestion flow (that wiring is covered in App.test.tsx). Two kinds of I/O
// happen here now: localStorage (the list's own state, unmocked — real jsdom
// storage, cleared every test) and the instructions fetch (mocked globally, since a
// real network call has no server to answer it in this environment).

function result(overrides: Partial<TonightResult> = {}): TonightResult {
  return {
    template: { id: "kycklinggryta", name: "Kycklinggryta", cost_tier: "mid", prep_time_band: "20-40min", cuisine: "swedish_nordic" },
    ingredients: [
      { role: "protein", name: "Kyckling", substituted: false },
      { role: "vegetable", name: "Morot", substituted: false },
    ],
    substitutions: [],
    score: 0.5,
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
    expect(label.style.textDecoration).toBe("line-through");
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
          ingredients: [{ role: "protein", name: "Torsk", substituted: false }],
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

  it("never renders a numeric quantity or currency string in an ingredient row", () => {
    mockFetch();
    render(<ShoppingList result={result()} portions={2} accessToken="tok" onNewSuggestion={vi.fn()} />);

    for (const row of screen.getAllByRole("listitem")) {
      expect(row.textContent).not.toMatch(/\d/);
      expect(row.textContent).not.toMatch(/kr|kronor|₤/i);
    }
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
