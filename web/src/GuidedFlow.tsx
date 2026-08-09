import { useEffect, useMemo, useReducer, useState } from "react";
import {
  ApiError,
  type ExcludedIngredientOption,
  type GuidedDirection,
  type GuidedDirectionsResponse,
  type GuidedOptions,
  type IngredientOption,
} from "./api";
import { allergyExclusionReason, capitalizeForSentence } from "./allergyLabels";
import { DinerPicker, useDinerSelection } from "./DinerPicker";
import { createGuidedClient } from "./guidedClient";
import { costTierLabel, costTierMeter, PREP_TIME_LABELS } from "./display";
import { ShoppingList, formatPortions, type ShoppingListMeal } from "./ShoppingList";
import { Button } from "./components/Button";
import { Card } from "./components/Card";
import { Chip } from "./components/Chip";
import {
  GUIDED_INTENTS,
  INITIAL_GUIDED,
  MIN_PORTIONS,
  guidedReducer,
  isFirstStep,
  mainParameter,
  matchesIngredientQuery,
  type GuidedState,
} from "./guided";
import type { StoredShoppingList } from "./shoppingListStorage";

// The guided quick-select flow (UX_FLOW §5): intent chip → main ingredient →
// pantry → three direction cards → portions → shopping list.
//
// Every step is a tap. There is no text input anywhere in this file and no free-text
// search — selection is always over the curated catalog, which is the whole
// distinction between this product and prompting a chatbot (UX_FLOW §1/§2). There is
// also no AI call: the direction set is the Meal Engine's, deterministic end to end.

function StepHeader({
  title,
  hint,
  onBack,
  backLabel,
}: {
  title: string;
  hint?: string;
  onBack: () => void;
  backLabel: string;
}) {
  return (
    <div className="guided-header">
      <Button type="button" variant="secondary" className="guided-back" onClick={onBack}>
        {backLabel}
      </Button>
      <h2 className="guided-title">{title}</h2>
      {hint && <p className="muted guided-hint">{hint}</p>}
    </div>
  );
}

/**
 * A grid of tapable ingredients (§5 steps 2 and 3). `selected` is passed only for the
 * multi-select pantry grid — the main-ingredient grid is a single choice that moves
 * straight on, so its chips carry no pressed state to render.
 */
function IngredientGrid({
  label,
  options,
  selected,
  onTap,
}: {
  label: string;
  options: readonly IngredientOption[];
  selected?: readonly string[];
  onTap: (ingredientId: string) => void;
}) {
  return (
    <div role="group" aria-label={label} className="ingredient-grid">
      {options.map((option) => (
        <Chip
          key={option.id}
          className="ingredient-grid__item"
          pressed={selected ? selected.includes(option.id) : undefined}
          onClick={() => onTap(option.id)}
        >
          {option.name}
        </Chip>
      ))}
    </div>
  );
}

/**
 * Step 2's filter-miss explanation (requirement 4): a catalog ingredient the query
 * matched, but that the household cannot select because it excludes one of its own
 * declared allergies. Rendered as text, not a `Chip`, so nothing about it reads as
 * tappable — this is display only and must never widen the selectable set.
 */
function ExcludedIngredientNotice({ excluded }: { excluded: ExcludedIngredientOption }) {
  return (
    <p className="excluded-ingredient-notice" role="status">
      {capitalizeForSentence(excluded.name)} är utesluten på grund av{" "}
      {allergyExclusionReason(excluded.allergies)}.
    </p>
  );
}

/**
 * One direction card (§5 step 4). Cost is the shared three-dot meter with a Swedish
 * accessible label — a display-only rendering of the curated `cost_tier`, never the
 * raw enum and never an invented kronor figure (ARCHITECTURE §5.1).
 */
function DirectionCard({
  direction,
  onChoose,
}: {
  direction: GuidedDirection;
  onChoose: () => void;
}) {
  const covered = direction.ingredients.filter((ingredient) => ingredient.inPantry);

  return (
    <Card className="direction-card">
      <h3 className="direction-card__name">{direction.template.name}</h3>
      <p className="direction-card__summary">{direction.summary}</p>
      <p className="direction-card__meta">
        <span role="img" aria-label={costTierLabel(direction.template.cost_tier)}>
          <span aria-hidden="true">{costTierMeter(direction.template.cost_tier)}</span>
        </span>{" "}
        · {PREP_TIME_LABELS[direction.template.prep_time_band]}
      </p>
      {covered.length > 0 && (
        <p className="direction-card__covered">
          Du har redan: {covered.map((ingredient) => ingredient.name).join(", ")}
        </p>
      )}
      <Button type="button" variant="primary" onClick={onChoose}>
        Välj
      </Button>
    </Card>
  );
}

/**
 * UX_FLOW §9's "no good direction fits pantry input": offer to loosen, never a dead
 * end. The actions are the two constraints the household actually added, so there is
 * always something to give up short of starting over.
 */
function NoDirections({
  state,
  onClearPantry,
  onClearMain,
  onBack,
}: {
  state: GuidedState;
  onClearPantry: () => void;
  onClearMain: () => void;
  onBack: () => void;
}) {
  const canLoosenPantry = state.pantry.length > 0;
  const canLoosenMain = state.main?.kind !== "any";

  return (
    <Card className="state-card">
      <p role="status">Inga rätter passar riktigt ihop just nu.</p>
      <p className="muted">Ta bort något av dina val, så hittar vi fler förslag.</p>
      <div className="chip-row">
        {canLoosenPantry && (
          <Button type="button" variant="primary" onClick={onClearPantry}>
            Bortse från vad jag har hemma
          </Button>
        )}
        {canLoosenMain && (
          <Button
            type="button"
            variant={canLoosenPantry ? "secondary" : "primary"}
            onClick={onClearMain}
          >
            Visa alla huvudingredienser
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={onBack}>
          Ändra mina val
        </Button>
      </div>
    </Card>
  );
}

/**
 * The household's own constraints leave nothing at all — a different problem from
 * "this combination is too narrow", so it gets a different way out: the household
 * profile, not the flow's own selections.
 */
function NoSafeTemplates({ onRestart }: { onRestart: () => void }) {
  return (
    <Card className="state-card">
      <p role="status">Vi hittar inga rätter som passar hushållets alla begränsningar.</p>
      <p className="muted">Se över allergier och kostval i hushållet, så öppnar fler rätter upp sig.</p>
      <Button type="button" variant="primary" onClick={onRestart}>
        Börja om
      </Button>
    </Card>
  );
}

export function GuidedFlow({
  accessToken,
  onExit,
  resume,
}: {
  accessToken: string;
  onExit: () => void;
  /**
   * A shopping list already on the device that belongs to this flow rather than to
   * the Tonight card — a reload in the shop (UX_FLOW §7). Starting on it, rather
   * than back at the chips, is the difference between a half-checked list surviving
   * a reload and silently disappearing.
   */
  resume?: StoredShoppingList;
}) {
  const [state, dispatch] = useReducer(
    guidedReducer,
    resume
      ? { ...INITIAL_GUIDED, step: "shopping" as const, chosenTemplateId: resume.templateId }
      : INITIAL_GUIDED,
  );
  const [options, setOptions] = useState<GuidedOptions | null>(null);
  const [response, setResponse] = useState<GuidedDirectionsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the retry buttons to re-run a fetch below without duplicating its
  // request/cancellation logic in a second callback, as ShoppingList's Instructions
  // and Gate's offline screen both already do.
  const [attempt, setAttempt] = useState(0);

  // Who is eating, seeded to everyone from the labels the options request returns.
  // The flow never waits on this: the first request carries no diner set at all, and
  // the picker adjusts an answer that is already on screen (condition 2).
  const diners = useDinerSelection(options?.diners);

  // One client for both endpoints, rebuilt when the diner set changes. Neither of its
  // methods takes a diner set, so the grid and the directions cannot be built for
  // different people — see guidedClient.ts. Rebuilding re-runs both effects below,
  // which is the point: a new diner set needs a new grid as much as a new direction
  // set.
  const client = useMemo(
    () => createGuidedClient(accessToken, diners.parameter),
    [accessToken, diners.parameter],
  );

  // Both grids in one small request at mount, so steps 2 and 3 never make the
  // household wait between taps.
  useEffect(() => {
    let cancelled = false;
    // Deliberately *not* cleared first: a diner toggle refetches this, and blanking
    // the roster mid-flight would take the labels away from the very picker that
    // triggered the request — which reads as the selection resetting itself.
    client
      .fetchOptions()
      .then((loaded) => {
        if (!cancelled) setOptions(loaded);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Dropped, not left on screen, for the same reason the direction set below is:
        // after a failed refetch these grids answer a question the household has
        // already changed. A diner toggle is exactly that — a grid built while the
        // fish-allergic member was away keeps offering "lax" as a tap target once she
        // is back at the table. The directions request would refuse it server-side, so
        // this is not a safety hole; it is the trap tap target the flow is built to
        // avoid.
        setOptions(null);
        setError(err instanceof ApiError ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, attempt]);

  // Step 2's type-to-filter (requirement 1-6): entirely a display layer over the
  // already-fetched `options.mainIngredients`, the household's own safe set — no
  // request, no change to `state.main`. An empty query is the identity filter, so
  // the grid below never needs a separate "no query" branch.
  const trimmedMainQuery = state.mainQuery.trim();
  const hasMainQuery = trimmedMainQuery.length > 0;
  const matchingMainIngredients = hasMainQuery
    ? (options?.mainIngredients ?? []).filter((option) =>
        matchesIngredientQuery(option.name, trimmedMainQuery),
      )
    : (options?.mainIngredients ?? []);
  const excludedMainMatches = hasMainQuery
    ? (options?.excludedMainIngredients ?? []).filter((option) =>
        matchesIngredientQuery(option.name, trimmedMainQuery),
      )
    : [];
  // A miss falls back to the full grid rather than an empty one (requirement 1: the
  // grid stays visible and tappable at all times) — "no match" is communicated by
  // the message above it, never by the grid disappearing.
  const mainGridOptions =
    matchingMainIngredients.length > 0 ? matchingMainIngredients : (options?.mainIngredients ?? []);
  const noMainMatches = hasMainQuery && matchingMainIngredients.length === 0 && excludedMainMatches.length === 0;

  const main = mainParameter(state);
  const pantryKey = state.pantry.join(",");
  const wantsDirections = state.step === "directions" && state.intent !== null && main !== null;

  // Refetches whenever the inputs change, which is what makes the §9 loosen actions
  // work without their own request logic: they change `main` or the pantry and stay
  // on this step, so the effect below simply asks again.
  useEffect(() => {
    if (!wantsDirections || state.intent === null || main === null) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    client
      .fetchDirections({
        intent: state.intent,
        main,
        pantry: pantryKey.length > 0 ? pantryKey.split(",") : [],
      })
      .then((loaded) => {
        if (!cancelled) setResponse(loaded);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // The previous set is dropped, not left on screen: after a failed refetch it
        // answers a question the household has already changed — tapping one of its
        // cards would build a shopping list for the constraints it just abandoned.
        setResponse(null);
        setError(err instanceof ApiError ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, wantsDirections, state.intent, main, pantryKey, attempt]);

  const chosen = response?.directions.find(
    (direction) => direction.template.id === state.chosenTemplateId,
  );

  // On a resumed session there is no fetched direction to read a name from, so the
  // shopping list is rebuilt from what storage kept. Its items come from storage
  // either way, so the empty `ingredients` here is never used to build a list.
  const resumedMeal: ShoppingListMeal | undefined = resume
    ? {
        template: { id: resume.templateId, name: resume.templateName ?? "Inköpslista" },
        ingredients: [],
        substitutions: resume.substitutions ?? [],
      }
    : undefined;
  const meal = chosen ?? (state.step === "shopping" ? resumedMeal : undefined);

  function handleBack() {
    if (isFirstStep(state)) onExit();
    else dispatch({ type: "back" });
  }

  const backLabel = isFirstStep(state) ? "Till ikväll" : "Tillbaka";

  return (
    <div className="guided-flow">
      {error && (
        <Card className="state-card">
          <p role="alert" className="error-text">
            {error}
          </p>
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              setError(null);
              setAttempt((n) => n + 1);
            }}
          >
            Försök igen
          </Button>
        </Card>
      )}

      {state.step === "intent" && (
        <>
          <StepHeader title="Vad är du sugen på?" onBack={handleBack} backLabel={backLabel} />
          <div role="group" aria-label="Välj inriktning" className="chip-row">
            {GUIDED_INTENTS.map((intent) => (
              <Chip
                key={intent.id}
                pressed={state.intent === intent.id}
                onClick={() => dispatch({ type: "select_intent", intent: intent.id })}
              >
                {intent.label}
              </Chip>
            ))}
          </div>
        </>
      )}

      {state.step === "main" && (
        <>
          <StepHeader
            title="Vilken huvudingrediens?"
            hint="Välj en, eller låt oss föreslå utifrån säsong och pris."
            onBack={handleBack}
            backLabel={backLabel}
          />
          {options ? (
            <>
              <input
                type="text"
                className="input guided-main-filter"
                placeholder="Skriv för att smalna av listan…"
                aria-label="Smalna av huvudingredienserna"
                value={state.mainQuery}
                onChange={(event) => dispatch({ type: "set_main_query", query: event.target.value })}
              />
              {excludedMainMatches.map((excluded) => (
                <ExcludedIngredientNotice key={excluded.id} excluded={excluded} />
              ))}
              {noMainMatches && <p className="muted" role="status">Ingen träff.</p>}
              <IngredientGrid
                label="Huvudingredienser"
                options={mainGridOptions}
                onTap={(ingredientId) => dispatch({ type: "select_main", ingredientId })}
              />
              <Button
                type="button"
                variant="primary"
                className="guided-action"
                onClick={() => dispatch({ type: "suggest_main" })}
              >
                Föreslå åt mig
              </Button>
            </>
          ) : (
            !error && <p className="muted">Hämtar ingredienser…</p>
          )}
        </>
      )}

      {state.step === "pantry" && (
        <>
          <StepHeader
            title="Vad har du hemma?"
            hint="Valfritt — vi använder det bara för att välja förslag, och sparar det inte."
            onBack={handleBack}
            backLabel={backLabel}
          />
          {options ? (
            <>
              <IngredientGrid
                label="Varor hemma"
                options={options.pantryIngredients}
                selected={state.pantry}
                onTap={(ingredientId) => dispatch({ type: "toggle_pantry", ingredientId })}
              />
              <Button
                type="button"
                variant="primary"
                className="guided-action"
                onClick={() => dispatch({ type: "confirm_pantry" })}
              >
                {state.pantry.length > 0 ? "Visa förslag" : "Hoppa över"}
              </Button>
            </>
          ) : (
            !error && <p className="muted">Hämtar ingredienser…</p>
          )}
        </>
      )}

      {state.step === "directions" && (
        <>
          <StepHeader title="Tre förslag" onBack={handleBack} backLabel={backLabel} />
          {loading && <p className="muted">Hämtar förslag…</p>}
          {!loading && response && response.directions.length > 0 && (
            <div className="direction-list">
              {response.directions.map((direction) => (
                <DirectionCard
                  key={direction.template.id}
                  direction={direction}
                  onChoose={() =>
                    dispatch({
                      type: "choose_direction",
                      templateId: direction.template.id,
                      portions: response.portions,
                    })
                  }
                />
              ))}
            </div>
          )}
          {!loading && response?.reason === "no_directions" && (
            <NoDirections
              state={state}
              onClearPantry={() => dispatch({ type: "clear_pantry" })}
              onClearMain={() => dispatch({ type: "clear_main" })}
              onBack={handleBack}
            />
          )}
          {!loading && response?.reason === "no_safe_templates" && (
            <NoSafeTemplates onRestart={() => dispatch({ type: "restart" })} />
          )}
          {/*
            Below the cards, not above them: a refinement on the suggestions already
            on screen, never a question asked before there is anything to refine. It
            stays rendered through both §9 empty states, where "the child is not
            eating tonight" is often the real way out.
          */}
          <DinerPicker state={diners} busy={loading} />
        </>
      )}

      {state.step === "portions" && chosen && state.portions !== null && (
        <>
          <StepHeader title="Hur många portioner?" onBack={handleBack} backLabel={backLabel} />
          <Card className="portions-card">
            <h3>{chosen.template.name}</h3>
            <div className="portions-stepper">
              <Button
                type="button"
                variant="secondary"
                aria-label="Färre portioner"
                disabled={state.portions <= MIN_PORTIONS}
                onClick={() => dispatch({ type: "adjust_portions", delta: -1 })}
              >
                −
              </Button>
              <span role="status" className="portions-value">
                {formatPortions(state.portions)}
              </span>
              <Button
                type="button"
                variant="secondary"
                aria-label="Fler portioner"
                onClick={() => dispatch({ type: "adjust_portions", delta: 1 })}
              >
                +
              </Button>
            </div>
            <Button
              type="button"
              variant="primary"
              onClick={() => dispatch({ type: "confirm_portions" })}
              className="guided-action"
            >
              Till inköpslistan
            </Button>
          </Card>
        </>
      )}

      {state.step === "shopping" && meal && (
        <>
          <StepHeader title="Inköpslista" onBack={handleBack} backLabel={backLabel} />
          <ShoppingList
            result={meal}
            portions={state.portions ?? undefined}
            accessToken={accessToken}
            onNewSuggestion={() => dispatch({ type: "restart" })}
            newSuggestionLabel="Börja om"
          />
        </>
      )}
    </div>
  );
}
