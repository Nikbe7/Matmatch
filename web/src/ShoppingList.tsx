import { useEffect, useState } from "react";
import type { IngredientAlternative, TonightIngredient, TonightResult } from "./api";
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
import { formatQuantity, formatPortions } from "./display";
import { Button } from "./components/Button";
import { IngredientPopover } from "./components/IngredientPopover";

// The shopping list for an accepted Tonight suggestion. Deliberately no fetch here
// at all — everything it needs (the result, the portions count) arrives as props,
// and its own state round-trips through localStorage only (shoppingListStorage.ts).

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

/**
 * The variety note (#223) — one curated sentence under a row the household's pantry
 * covered with a different variety than the dish names.
 *
 * Coverage only *marks*; it never swaps the ingredient or rescales the amount. So on
 * a "Har hemma" row this sentence is the only thing between a household and a dish
 * that quietly came out different — they marked vispgrädde, the row still says
 * matlagningsgrädde, and nothing else on the screen says the sauce will be thicker.
 *
 * `role="note"` rather than `status`: it is standing information about the row, not
 * something that just happened, so it must not be announced over whatever the
 * household is doing. Quiet styling for the same reason the swap badge is quiet —
 * this is one household member telling another what to expect, not a warning.
 */
function VarietyNote({ item }: { item: ShoppingListItem }) {
  if (!item.varietyNote) return null;
  return (
    <p className="list-row__variety-note" role="note">
      {item.varietyNote}
    </p>
  );
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
  pantryIngredientIds,
  explanation,
  portions,
  diners,
  accessToken,
  onNewSuggestion,
  newSuggestionLabel = "Nytt förslag",
  onCook,
}: {
  result: ShoppingListMeal;
  /**
   * Tonight's pantry-row selection at the moment of choice (#200) — ingredient ids,
   * applied on top of whichever base list wins below (freshly built or resumed from
   * storage). The guided flow doesn't pass this: its ingredients arrive from the
   * server already flagged `inPantry` (`src/api/guidedCatalog.ts`), which
   * `freshShoppingList` reads directly.
   */
  pantryIngredientIds?: readonly string[];
  /**
   * The dish's one-line "why" (#122/#125) — Tonight's `suggestionReasonLine` or the
   * guided flow's own deterministic `GuidedDirection.summary`. This is the one place
   * both flows converge (`ListaRoute` and `GuidedFlow`'s inline "shopping" step both
   * render this component), so it is where #125's "explanation reachable from
   * wherever the ingredient list already is" lands rather than a new screen.
   * Omitted, never guessed, on a list resumed from storage after a reload — neither
   * source persists it.
   */
  explanation?: string;
  /**
   * Omitted on a list re-opened from storage after a reload: the household's portion
   * count is not in hand there, and the line is left off rather than guessed — what
   * matters in the shop is the list itself.
   */
  portions?: number;
  /**
   * The diner subset this list was built for, in the same spelling `fetchTonight`
   * takes (`FetchTonightOptions.diners`) — forwarded to #124's ingredient-swap
   * popover so its quantities agree with the list rather than silently widening to
   * the whole household. Omitted for the same reason
   * `portions` is: a list reopened from storage has no diner selection in hand
   * either, and the popover falls back to the whole household exactly as the
   * accepted list's own quantities would have.
   */
  diners?: string;
  accessToken: string;
  onNewSuggestion: () => void;
  newSuggestionLabel?: string;
  /**
   * Opens the cook screen for this dish (#154). Omitted on a list resumed from
   * storage with no ingredients to cook from, in which case the button is left off
   * rather than leading to an empty screen.
   */
  onCook?: () => void;
}) {
  const [items, setItems] = useState<ShoppingListItem[]>(() => {
    const stored = loadShoppingList(result.template.id);
    const base = stored ? stored.items : freshShoppingList(result.template.id, result.ingredients).items;
    // Applied after the stored-vs-fresh choice above, not before, and to either
    // outcome: a household can accept the same dish twice in one session — reroll
    // away, mark a new pantry item, accept again — and the second accept must still
    // land on top of a list already stored from the first (#200). Only ever moves an
    // item *into* "Har hemma", never out — a household that already moved something
    // there by hand, in an earlier session, keeps it there even if this particular
    // accept didn't tap it.
    if (!pantryIngredientIds || pantryIngredientIds.length === 0) return base;
    return base.map((item) =>
      item.section === "to_buy" && pantryIngredientIds.includes(item.ingredientId)
        ? { ...item, section: "have_at_home" as const }
        : item,
    );
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
   * id and the (unchanged, but server-carried anyway) scaled quantity all
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
          bought: false,
          swappedFrom: {
            name: item.name,
            ingredientId: item.ingredientId,
            bought: item.bought,
            quantity: item.quantity,
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
        {explanation && <p className="shopping-list__reason muted">{explanation}</p>}
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
              <VarietyNote item={item} />
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
              <VarietyNote item={item} />
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
            </li>
          ))}
        </ul>
      </section>

      {/* Cooking is what the list is *for*, so it takes the primary slot and
          "Nytt förslag" steps down to secondary (#154). The instructions themselves
          no longer live on this screen at all — one surface owns them. */}
      {onCook && (
        <Button type="button" variant="primary" onClick={onCook}>
          Börja laga
        </Button>
      )}

      <Button
        type="button"
        variant={onCook ? "secondary" : "primary"}
        onClick={handleNewSuggestion}
      >
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
 * `TonightResult` to read a dish name or cost tier from when offline, only what
 * `shoppingListStorage.ts` persisted, so this renders just the checklist itself.
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
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
