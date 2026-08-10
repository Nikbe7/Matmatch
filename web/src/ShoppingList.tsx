import { useEffect, useState } from "react";
import { ApiError, fetchInstructions, type TonightIngredient, type TonightResult } from "./api";
import {
  clearShoppingList,
  freshShoppingList,
  loadShoppingList,
  saveShoppingList,
  SHOPPING_LIST_VERSION,
  type ShoppingListItem,
  type ShoppingListSection,
  type StoredShoppingList,
} from "./shoppingListStorage";
import { allergenMarkingText } from "./allergyLabels";
import { Button } from "./components/Button";
import { Card } from "./components/Card";

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

interface IndexedItem extends ShoppingListItem {
  index: number;
}

function withIndex(items: readonly ShoppingListItem[]): IndexedItem[] {
  return items.map((item, index) => ({ ...item, index }));
}

/**
 * The household-union allergen marking for one item (#116). Same visual register as
 * the allergy chips (#101, UX_FLOW §6, `.allergy-group` in app.css): a warning glyph
 * plus text, so the distinction is never colour alone, and rendered as plain text
 * rather than a `Chip` — nothing about it reads as tappable, matching the existing
 * `.excluded-ingredient-notice` precedent for the same reason.
 */
function AllergenMarks({ allergens }: { allergens: ShoppingListItem["allergens"] }) {
  if (allergens.length === 0) return null;

  return (
    <ul className="ingredient-allergen-list">
      {allergens.map((marking) => (
        <li key={marking.allergy} className="ingredient-allergen-notice">
          <span aria-hidden="true">⚠ </span>
          {allergenMarkingText(marking.allergy, marking.members)}
        </li>
      ))}
    </ul>
  );
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
    <section className="card">
      <h3>Så här gör du</h3>
      {state.status === "loading" && <p className="muted">Skapar instruktioner…</p>}
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
          <Button type="button" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Försök igen
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * What the shopping list needs from a chosen meal, which is less than a full
 * `TonightResult`: a name to head the list, ingredients to check off, and the
 * substitutions the instructions call needs. Declared structurally so both callers
 * fit — the Tonight card's accepted suggestion and the guided flow's chosen
 * direction, whose ingredients additionally carry `inPantry`.
 */
export interface ShoppingListMeal {
  template: { id: string; name: string };
  ingredients: readonly (TonightIngredient & { inPantry?: boolean })[];
  substitutions: TonightResult["substitutions"];
}

export function ShoppingList({
  result,
  portions,
  accessToken,
  onNewSuggestion,
  newSuggestionLabel = "Ny förslag",
}: {
  result: ShoppingListMeal;
  /**
   * Omitted on a list re-opened from storage after a reload: the household's portion
   * count is not in hand there, and the line is left off rather than guessed — what
   * matters in the shop is the list itself.
   */
  portions?: number;
  accessToken: string;
  onNewSuggestion: () => void;
  newSuggestionLabel?: string;
}) {
  const [items, setItems] = useState<ShoppingListItem[]>(() => {
    const stored = loadShoppingList(result.template.id);
    return stored ? stored.items : freshShoppingList(result.template.id, result.ingredients).items;
  });

  // The dish name and substitutions are stored alongside the items so this list can
  // be re-opened after a reload without a fetched result to read them from — the
  // guided flow's dish is one no Tonight response mentions (UX_FLOW §7).
  useEffect(() => {
    saveShoppingList({
      version: SHOPPING_LIST_VERSION,
      templateId: result.template.id,
      templateName: result.template.name,
      substitutions: result.substitutions.map((substitution) => ({
        slot_index: substitution.slot_index,
        substitute_ingredient_id: substitution.substitute_ingredient_id,
      })),
      items,
    });
  }, [result.template.id, result.template.name, result.substitutions, items]);

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
    <Card>
      <h2>{result.template.name}</h2>
      {portions !== undefined && <p>{formatPortions(portions)}</p>}

      <section className="list-section">
        <h3>Att köpa ({toBuy.length})</h3>
        <ul>
          {toBuy.map((item) => (
            <li key={item.index} className="list-row">
              <label className={item.bought ? "checkbox-label bought" : "checkbox-label"}>
                <input
                  type="checkbox"
                  checked={item.bought}
                  onChange={() => toggleBought(item.index)}
                />
                {item.name}
              </label>
              <Button
                type="button"
                variant="secondary"
                onClick={() => moveTo(item.index, "have_at_home")}
              >
                Har hemma
              </Button>
              <AllergenMarks allergens={item.allergens} />
            </li>
          ))}
        </ul>
      </section>

      <section className="list-section">
        <h3>Har hemma ({haveAtHome.length})</h3>
        <ul>
          {haveAtHome.map((item) => (
            <li key={item.index} className="list-row">
              {item.name}
              <Button type="button" variant="secondary" onClick={() => moveTo(item.index, "to_buy")}>
                Att köpa
              </Button>
              <AllergenMarks allergens={item.allergens} />
            </li>
          ))}
        </ul>
      </section>

      <Instructions accessToken={accessToken} templateId={result.template.id} substitutions={result.substitutions} />

      <Button type="button" variant="primary" onClick={handleNewSuggestion}>
        {newSuggestionLabel}
      </Button>
    </Card>
  );
}

/**
 * Rendered when the app opens with no connection and `fetchTonight` never
 * reached the server at all (App.tsx's Gate) — the offline case UX_FLOW §7
 * asks for. Deliberately not `ShoppingList` above: there is no fetched
 * `TonightResult` to read a dish name, cost tier or instructions from when
 * offline, only what `shoppingListStorage.ts` persisted — a name and
 * instructions fetch, so this renders just the checklist itself.
 */
export function OfflineShoppingList({ list }: { list: StoredShoppingList }) {
  const [items, setItems] = useState<ShoppingListItem[]>(list.items);

  useEffect(() => {
    saveShoppingList({ version: SHOPPING_LIST_VERSION, templateId: list.templateId, items });
  }, [list.templateId, items]);

  function moveTo(index: number, section: ShoppingListSection) {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, section } : item)));
  }

  function toggleBought(index: number) {
    setItems((current) =>
      current.map((item, i) => (i === index ? { ...item, bought: !item.bought } : item)),
    );
  }

  const toBuy = withIndex(items).filter((item) => item.section === "to_buy");
  const haveAtHome = withIndex(items).filter((item) => item.section === "have_at_home");

  return (
    <Card>
      <h2>Inköpslista</h2>
      <p role="status">Ingen anslutning — visar din sparade inköpslista.</p>

      <section className="list-section">
        <h3>Att köpa ({toBuy.length})</h3>
        <ul>
          {toBuy.map((item) => (
            <li key={item.index} className="list-row">
              <label className={item.bought ? "checkbox-label bought" : "checkbox-label"}>
                <input
                  type="checkbox"
                  checked={item.bought}
                  onChange={() => toggleBought(item.index)}
                />
                {item.name}
              </label>
              <Button
                type="button"
                variant="secondary"
                onClick={() => moveTo(item.index, "have_at_home")}
              >
                Har hemma
              </Button>
              <AllergenMarks allergens={item.allergens} />
            </li>
          ))}
        </ul>
      </section>

      <section className="list-section">
        <h3>Har hemma ({haveAtHome.length})</h3>
        <ul>
          {haveAtHome.map((item) => (
            <li key={item.index} className="list-row">
              {item.name}
              <Button type="button" variant="secondary" onClick={() => moveTo(item.index, "to_buy")}>
                Att köpa
              </Button>
              <AllergenMarks allergens={item.allergens} />
            </li>
          ))}
        </ul>
      </section>
    </Card>
  );
}
