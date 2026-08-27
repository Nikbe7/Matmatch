import { useEffect, useState } from "react";
import {
  ApiError,
  fetchIngredientAlternatives,
  type IngredientAlternative,
  type IngredientAlternativesResult,
} from "../api";
import { costTierLabel } from "../display";
import { matchesIngredientQuery } from "../guided";
import { Button } from "./Button";
import { Chip } from "./Chip";

// #124: tapping an ingredient opens this popover — intent filters first (Billigare,
// Liknande), a search box below them over the wider role-valid catalog (the #110
// type-to-filter idiom, filtered client-side against one fetch), no AI path in this
// slice (#132). Every candidate already resolved against the deterministic catalog
// server-side before it reached this component; nothing here filters again.

type FetchState =
  | { status: "loading" }
  | { status: "ready"; data: IngredientAlternativesResult }
  | { status: "failed"; reason?: string };

type Tab = "cheaper" | "similar" | "search";

/**
 * "Billigare" / "Liknande" chips plus a search box, sourced from one fetch per
 * popover open — never a request per keystroke or per filter tap.
 */
function AlternativesList({
  data,
  onApply,
}: {
  data: IngredientAlternativesResult;
  onApply: (alternative: IngredientAlternative) => void;
}) {
  const hasCheaper = (data.cheaper?.length ?? 0) > 0;
  const hasSimilar = (data.similar?.length ?? 0) > 0;
  const defaultTab: Tab = hasCheaper ? "cheaper" : hasSimilar ? "similar" : "search";

  const [manualTab, setManualTab] = useState<Tab | undefined>(undefined);
  const [query, setQuery] = useState("");
  const activeTab = manualTab ?? defaultTab;

  function selectTab(tab: Tab) {
    setManualTab(tab);
    setQuery("");
  }

  const searchPool = data.searchPool ?? [];
  const results: IngredientAlternative[] =
    activeTab === "cheaper"
      ? (data.cheaper ?? [])
      : activeTab === "similar"
        ? (data.similar ?? [])
        : searchPool.filter((alternative) => matchesIngredientQuery(alternative.name, query));

  return (
    <div className="ingredient-popover__body">
      {(hasCheaper || hasSimilar) && (
        <div role="group" aria-label="Filtrera alternativ" className="ingredient-popover__filters">
          {hasCheaper && (
            <Chip pressed={activeTab === "cheaper"} onClick={() => selectTab("cheaper")}>
              Billigare
            </Chip>
          )}
          {hasSimilar && (
            <Chip pressed={activeTab === "similar"} onClick={() => selectTab("similar")}>
              Liknande
            </Chip>
          )}
        </div>
      )}

      <input
        type="text"
        className="input ingredient-popover__search"
        placeholder="Sök alternativ"
        aria-label="Sök alternativ"
        value={activeTab === "search" ? query : ""}
        onChange={(event) => {
          setManualTab("search");
          setQuery(event.target.value);
        }}
      />

      {results.length === 0 ? (
        <p className="muted">Inga alternativ hittades.</p>
      ) : (
        <ul className="ingredient-popover__results">
          {results.map((alternative) => (
            <li key={alternative.ingredientId}>
              <button
                type="button"
                className="ingredient-popover__option"
                onClick={() => onApply(alternative)}
              >
                <span>{alternative.name}</span>
                <span className="muted">{costTierLabel(alternative.costTier)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function IngredientPopover({
  accessToken,
  templateId,
  diners,
  ingredientName,
  slotIndex,
  ingredientId,
  onApply,
  onClose,
}: {
  accessToken: string;
  templateId: string;
  /** The diner subset the shopping list itself was built for (App.tsx/GuidedFlow.tsx's
   * `diners.parameter`) — forwarded so a candidate's eligibility and quantity agree
   * with the rest of the list rather than silently widening to the whole household. */
  diners?: string;
  ingredientName: string;
  slotIndex: number;
  ingredientId: string;
  onApply: (alternative: IngredientAlternative) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    fetchIngredientAlternatives(accessToken, templateId, slotIndex, ingredientId, diners)
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "failed", reason: err instanceof ApiError ? err.message : String(err) });
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, templateId, slotIndex, ingredientId, diners, attempt]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="ingredient-popover-backdrop" onClick={onClose}>
      <div
        className="ingredient-popover"
        role="dialog"
        aria-modal="true"
        aria-label={`Byt ut ${ingredientName}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ingredient-popover__header">
          <h3>{ingredientName}</h3>
          <button type="button" className="ingredient-popover__close" onClick={onClose} aria-label="Stäng">
            ×
          </button>
        </div>

        {state.status === "loading" && <p className="muted">Laddar alternativ…</p>}

        {state.status === "failed" && (
          <div>
            <p role="alert">Det gick inte att hämta alternativ just nu.</p>
            <Button type="button" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
              Försök igen
            </Button>
          </div>
        )}

        {state.status === "ready" && !state.data.substitutable && (
          <p>Den här ingrediensen är rätten i sig — inget att byta ut.</p>
        )}

        {state.status === "ready" && state.data.substitutable && (
          <AlternativesList data={state.data} onApply={onApply} />
        )}
      </div>
    </div>
  );
}
