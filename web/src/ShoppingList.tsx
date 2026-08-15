import { useEffect, useState } from "react";
import {
  ApiError,
  fetchInstructions,
  type IngredientAlternative,
  type TonightIngredient,
  type TonightResult,
} from "./api";
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
import { formatQuantity } from "./display";
import { Button } from "./components/Button";
import { IngredientPopover } from "./components/IngredientPopover";

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

/**
 * The right-aligned amount column (#139 rebuild) — its own element, separate from
 * the ingredient name, so a column of amounts lines up against the row's right
 * edge regardless of how long the name to its left runs. Tabular figures so the
 * digits themselves don't shift width row to row. "efter smak" flows through the
 * same path rather than getting a special case: a seasoned-to-taste ingredient is
 * still something to have in the house.
 */
function ItemAmount({ item }: { item: ShoppingListItem }) {
  return <span className="item-amount">{formatQuantity(item.quantity)}</span>;
}

function withIndex(items: readonly ShoppingListItem[]): IndexedItem[] {
  return items.map((item, index) => ({ ...item, index }));
}

/**
 * The row's tap target for #124's ingredient-swap popover — the ingredient name
 * only (#139: the amount sits in its own right-aligned column outside this
 * button). "Bought" styling moves here from the checkbox `<label>` it used to
 * live inside: the label now wraps only the checkbox, so the strikethrough has
 * to be reapplied to whatever still wraps the text.
 */
function IngredientTapButton({ item, onTap }: { item: ShoppingListItem; onTap: () => void }) {
  return (
    <button
      type="button"
      className={item.bought ? "ingredient-tap bought" : "ingredient-tap"}
      onClick={onTap}
    >
      <span className="item-name">{item.name}</span>
      {/* Requirement 6: a swap "stays visibly a change" — a quiet badge, not a
          celebration, since it is one household member telling another what
          changed since the list was made, not a success state. */}
      {item.swappedFrom && (
        <span className="swapped-badge" role="status">
          bytt
        </span>
      )}
    </button>
  );
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
  diners,
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
  /**
   * The diner subset this list was built for, in the same spelling `fetchTonight`
   * takes (`FetchTonightOptions.diners`) — forwarded to #124's ingredient-swap
   * popover so its allergy gate and quantities agree with the list rather than
   * silently widening to the whole household. Omitted for the same reason
   * `portions` is: a list reopened from storage has no diner selection in hand
   * either, and the popover falls back to the whole household exactly as the
   * accepted list's own quantities would have.
   */
  diners?: string;
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

  // #124: the index of the item whose ingredient-swap popover is open, or null.
  // One popover at a time, closed on apply — matches the "closes on outside tap"
  // requirement, since the backdrop click already routes through `onClose`.
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  function moveTo(index: number, section: ShoppingListSection) {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, section } : item)));
  }

  function toggleBought(index: number) {
    setItems((current) =>
      current.map((item, i) => (i === index ? { ...item, bought: !item.bought } : item)),
    );
  }

  /**
   * Replaces the item at `index` with `alternative`, wholesale — name, ingredient
   * id, allergens and the (unchanged, but server-carried anyway) scaled quantity all
   * come from the response, so this never re-derives anything the popover's fetch
   * already resolved. `section` is left untouched (#124 requirement 6: a swap
   * updates the have/buy split in place, it does not move the item between
   * sections), and `bought` resets — a checkmark against the old ingredient means
   * nothing once the row names a different one. The item's prior state, `bought`
   * included, is kept on `swappedFrom` so one tap can undo it completely.
   */
  function applySwap(index: number, alternative: IngredientAlternative) {
    setItems((current) =>
      current.map((item, i) => {
        if (i !== index) return item;
        return {
          ...item,
          name: alternative.name,
          ingredientId: alternative.ingredientId,
          quantity: alternative.quantity,
          allergens: alternative.allergens,
          bought: false,
          swappedFrom: {
            name: item.name,
            ingredientId: item.ingredientId,
            bought: item.bought,
            quantity: item.quantity,
            allergens: item.allergens,
          },
        };
      }),
    );
    setOpenIndex(null);
  }

  /** Restores the item's state from right before its most recent swap. Only ever
   * reaches back one step — see `swappedFrom`'s own comment for why. */
  function undoSwap(index: number) {
    setItems((current) =>
      current.map((item, i) => {
        if (i !== index || !item.swappedFrom) return item;
        return { ...item, ...item.swappedFrom, swappedFrom: undefined };
      }),
    );
  }

  function handleNewSuggestion() {
    clearShoppingList();
    onNewSuggestion();
  }

  const toBuy = withIndex(items).filter((item) => item.section === "to_buy");
  const haveAtHome = withIndex(items).filter((item) => item.section === "have_at_home");
  const openItem = openIndex !== null ? items[openIndex] : undefined;

  return (
    <div className="shopping-list">
      <header className="shopping-list__header">
        <h2 className="shopping-list__title">{result.template.name}</h2>
        {portions !== undefined && (
          <p className="shopping-list__portions">{formatPortions(portions)}</p>
        )}
      </header>

      <section className="shopping-list__section">
        <h3 className="text-eyebrow shopping-list__section-label">
          Behöver handlas ({toBuy.length})
        </h3>
        <ul className="shopping-list__card">
          {toBuy.map((item) => (
            <li key={item.index} className="list-row">
              <label className="checkbox-only">
                <input
                  type="checkbox"
                  checked={item.bought}
                  onChange={() => toggleBought(item.index)}
                />
              </label>
              <IngredientTapButton item={item} onTap={() => setOpenIndex(item.index)} />
              <ItemAmount item={item} />
              <div className="list-row__actions">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => moveTo(item.index, "have_at_home")}
                >
                  Har hemma
                </Button>
                {item.swappedFrom && (
                  <Button type="button" variant="secondary" onClick={() => undoSwap(item.index)}>
                    Ångra bytet
                  </Button>
                )}
              </div>
              <AllergenMarks allergens={item.allergens} />
            </li>
          ))}
        </ul>
      </section>

      <section className="shopping-list__section">
        <h3 className="text-eyebrow shopping-list__section-label">
          Har hemma ({haveAtHome.length})
        </h3>
        <ul className="shopping-list__quiet-list">
          {haveAtHome.map((item) => (
            <li key={item.index} className="list-row list-row--quiet">
              <IngredientTapButton item={item} onTap={() => setOpenIndex(item.index)} />
              <ItemAmount item={item} />
              <div className="list-row__actions">
                <Button type="button" variant="secondary" onClick={() => moveTo(item.index, "to_buy")}>
                  Behöver handlas
                </Button>
                {item.swappedFrom && (
                  <Button type="button" variant="secondary" onClick={() => undoSwap(item.index)}>
                    Ångra bytet
                  </Button>
                )}
              </div>
              <AllergenMarks allergens={item.allergens} />
            </li>
          ))}
        </ul>
      </section>

      <Instructions accessToken={accessToken} templateId={result.template.id} substitutions={result.substitutions} />

      <Button type="button" variant="primary" onClick={handleNewSuggestion}>
        {newSuggestionLabel}
      </Button>

      {openItem && (
        <IngredientPopover
          accessToken={accessToken}
          templateId={result.template.id}
          diners={diners}
          ingredientName={openItem.name}
          slotIndex={openItem.slotIndex}
          ingredientId={openItem.ingredientId}
          onApply={(alternative) => applySwap(openIndex!, alternative)}
          onClose={() => setOpenIndex(null)}
        />
      )}
    </div>
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
    <div className="shopping-list">
      <header className="shopping-list__header">
        <h2 className="shopping-list__title">Inköpslista</h2>
        <p className="shopping-list__portions" role="status">
          Ingen anslutning — visar din sparade inköpslista.
        </p>
      </header>

      <section className="shopping-list__section">
        <h3 className="text-eyebrow shopping-list__section-label">
          Behöver handlas ({toBuy.length})
        </h3>
        <ul className="shopping-list__card">
          {toBuy.map((item) => (
            <li key={item.index} className="list-row">
              <label className={item.bought ? "checkbox-label bought" : "checkbox-label"}>
                <input
                  type="checkbox"
                  checked={item.bought}
                  onChange={() => toggleBought(item.index)}
                />
                <span className="item-name">{item.name}</span>
              </label>
              <ItemAmount item={item} />
              <div className="list-row__actions">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => moveTo(item.index, "have_at_home")}
                >
                  Har hemma
                </Button>
              </div>
              <AllergenMarks allergens={item.allergens} />
            </li>
          ))}
        </ul>
      </section>

      <section className="shopping-list__section">
        <h3 className="text-eyebrow shopping-list__section-label">
          Har hemma ({haveAtHome.length})
        </h3>
        <ul className="shopping-list__quiet-list">
          {haveAtHome.map((item) => (
            <li key={item.index} className="list-row list-row--quiet">
              <span className="item-name">{item.name}</span>
              <ItemAmount item={item} />
              <div className="list-row__actions">
                <Button type="button" variant="secondary" onClick={() => moveTo(item.index, "to_buy")}>
                  Behöver handlas
                </Button>
              </div>
              <AllergenMarks allergens={item.allergens} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
