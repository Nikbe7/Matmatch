import { useEffect, useState, type CSSProperties } from "react";
import { ApiError, fetchInstructions, type TonightResult } from "./api";
import {
  clearShoppingList,
  freshShoppingList,
  loadShoppingList,
  saveShoppingList,
  type ShoppingListItem,
  type ShoppingListSection,
} from "./shoppingListStorage";

// The shopping list for an accepted Tonight suggestion. Deliberately no fetch here
// at all — everything it needs (the result, the portions count) arrives as props,
// and its own state round-trips through localStorage only (shoppingListStorage.ts).

/**
 * "För 4 portioner" — rounded to one decimal only when the total isn't whole, so a
 * plain household of adults never sees a stray ".0". portions itself stays a raw
 * number over the wire; this formatting is the frontend's alone to change.
 */
export function formatPortions(portions: number): string {
  const rounded = Math.round(portions * 10) / 10;
  const display = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `För ${display} portioner`;
}

const boughtStyle: CSSProperties = { textDecoration: "line-through", opacity: 0.5 };

interface IndexedItem extends ShoppingListItem {
  index: number;
}

function withIndex(items: readonly ShoppingListItem[]): IndexedItem[] {
  return items.map((item, index) => ({ ...item, index }));
}

// Rendered below the shopping list, fetched once when the shopping list screen
// opens — not on the Tonight card, and independent of the shopping list's own
// (localStorage-backed) state, so a slow or failed generation never blocks checking
// items off the list.
type InstructionsState =
  | { status: "loading" }
  | { status: "ready"; steps: string[] }
  | { status: "failed"; reason?: string };

function Instructions({
  accessToken,
  templateId,
  substitutions,
}: {
  accessToken: string;
  templateId: string;
  substitutions: TonightResult["substitutions"];
}) {
  const [state, setState] = useState<InstructionsState>({ status: "loading" });
  // Bumped by the retry button to re-run the effect below without duplicating its
  // fetch/cancellation logic in a second callback.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    fetchInstructions(accessToken, templateId, substitutions)
      .then((response) => {
        if (cancelled) return;
        if (response.instructions) {
          setState({ status: "ready", steps: response.instructions });
        } else {
          setState({ status: "failed", reason: response.reason });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: "failed", reason: err instanceof ApiError ? err.message : String(err) });
      });

    // Guards against setting state after the shopping list screen has already been
    // left (e.g. "Ny förslag" tapped mid-generation) — a slow response must not
    // resurrect a component that's gone.
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, templateId, attempt]);

  return (
    <section>
      <h3>Så här gör du</h3>
      {state.status === "loading" && <p>Skapar instruktioner…</p>}
      {state.status === "ready" && (
        <ol>
          {state.steps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
      )}
      {state.status === "failed" && (
        <div>
          <p>Det gick inte att skapa instruktioner just nu.</p>
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Försök igen
          </button>
        </div>
      )}
    </section>
  );
}

export function ShoppingList({
  result,
  portions,
  accessToken,
  onNewSuggestion,
}: {
  result: TonightResult;
  portions: number;
  accessToken: string;
  onNewSuggestion: () => void;
}) {
  const [items, setItems] = useState<ShoppingListItem[]>(() => {
    const stored = loadShoppingList(result.template.id);
    return stored ? stored.items : freshShoppingList(result.template.id, result.ingredients).items;
  });

  useEffect(() => {
    saveShoppingList({ version: 1, templateId: result.template.id, items });
  }, [result.template.id, items]);

  function moveTo(index: number, section: ShoppingListSection) {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, section } : item)));
  }

  function toggleBought(index: number) {
    setItems((current) =>
      current.map((item, i) => (i === index ? { ...item, bought: !item.bought } : item)),
    );
  }

  function handleNewSuggestion() {
    clearShoppingList();
    onNewSuggestion();
  }

  const toBuy = withIndex(items).filter((item) => item.section === "to_buy");
  const haveAtHome = withIndex(items).filter((item) => item.section === "have_at_home");

  return (
    <div>
      <h2>{result.template.name}</h2>
      <p>{formatPortions(portions)}</p>

      <section>
        <h3>Att köpa ({toBuy.length})</h3>
        <ul>
          {toBuy.map((item) => (
            <li key={item.index}>
              <label style={item.bought ? boughtStyle : undefined}>
                <input
                  type="checkbox"
                  checked={item.bought}
                  onChange={() => toggleBought(item.index)}
                />
                {item.name}
              </label>
              <button type="button" onClick={() => moveTo(item.index, "have_at_home")}>
                Har hemma
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3>Har hemma ({haveAtHome.length})</h3>
        <ul>
          {haveAtHome.map((item) => (
            <li key={item.index}>
              {item.name}
              <button type="button" onClick={() => moveTo(item.index, "to_buy")}>
                Att köpa
              </button>
            </li>
          ))}
        </ul>
      </section>

      <Instructions accessToken={accessToken} templateId={result.template.id} substitutions={result.substitutions} />

      <button type="button" onClick={handleNewSuggestion}>
        Ny förslag
      </button>
    </div>
  );
}
