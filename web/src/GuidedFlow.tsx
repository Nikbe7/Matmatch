import { useEffect, useId, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import {
  type GuidedDirection,
  type GuidedDirectionsResponse,
  type GuidedOptions,
  type IngredientOption,
} from "./api";
import { DinerPicker, useDinerSelection } from "./DinerPicker";
import { createGuidedClient } from "./guidedClient";
import { costTierLabel, dinerChangeReasonLine, PREP_TIME_LABELS } from "./display";
import { ShoppingList, type ShoppingListMeal } from "./ShoppingList";
import { formatPortionsCount, portionsNoun } from "./display";
import { Button } from "./components/Button";
import { Card } from "./components/Card";
import { Chip } from "./components/Chip";
import { PantryPicker } from "./components/PantryPicker";
import { StateScreen } from "./components/StateScreen";
import { presentError, type PresentedError } from "./errorPresentation";
import {
  GUIDED_INTENTS,
  INITIAL_GUIDED,
  MAX_PORTIONS,
  MIN_PORTIONS,
  guidedReducer,
  isFirstStep,
  mainParameter,
  matchesIngredientQuery,
  type GuidedState,
} from "./guided";
import { clearShoppingList, type StoredShoppingList } from "./shoppingListStorage";

// The guided quick-select flow (UX_FLOW §5): intent chip → main ingredient →
// pantry → three direction cards → portions → shopping list.
//
// Every step is a tap. There is no text input anywhere in this file and no free-text
// search — selection is always over the curated catalog, which is the whole
// distinction between this product and prompting a chatbot (UX_FLOW §1/§2). There is
// also no AI call: the direction set is the Meal Engine's, deterministic end to end.

function BackIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M19 12H5" />
      <path d="M11 18 5 12l6-6" />
    </svg>
  );
}

/** The one round icon button every step (and the error screen) navigates back
 *  through — same accessible name (`backLabel`) the old full-width button
 *  carried, just a smaller tap target that still meets `--touch-target`. */
function GuidedBackButton({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <button type="button" className="guided-back" onClick={onBack} aria-label={label}>
      <BackIcon />
    </button>
  );
}

const GUIDED_STEP_COUNT = 3;

/**
 * The three-step progress indicator (#206) — segments, not the plain "Steg 1 av 3"
 * text it replaces. The flow's cost to a household is that they do not know how much
 * of it is left; three filled-or-not bars answer that at a glance, which a sentence
 * they have to read does not.
 *
 * Purely decorative to assistive tech: the segments are `aria-hidden` and the same
 * sentence is still announced, as `sr-only` text. A screen reader gains nothing from
 * three unlabelled bars and loses the wording it already had.
 */
function GuidedProgress({ current }: { current: number }) {
  return (
    <div className="guided-progress">
      <span className="sr-only">{`Steg ${current} av ${GUIDED_STEP_COUNT}`}</span>
      <span className="guided-progress__track" aria-hidden="true">
        {Array.from({ length: GUIDED_STEP_COUNT }, (_, index) => (
          <span
            key={index}
            className={
              index < current
                ? "guided-progress__segment guided-progress__segment--done"
                : "guided-progress__segment"
            }
          />
        ))}
      </span>
    </div>
  );
}

/**
 * The step header (requirement: read as a question, not a form) — reuses
 * `Screen`'s own header shape (`.screen-header`) rather than a second visual
 * language: an eyebrow above a display-face title, with the back button in
 * the header's action slot.
 *
 * `step` numbers the three real choice steps and renders the progress indicator;
 * `eyebrow` is the named, unnumbered label the three result steps carry instead.
 * Exactly one of the two is given — a result step has no position in a sequence the
 * household is still walking, and a choice step's position is the thing #206 wanted
 * shown rather than spelled out.
 */
function GuidedStepHeader({
  eyebrow,
  step,
  title,
  hint,
  onBack,
  backLabel,
}: {
  eyebrow?: string;
  step?: number;
  title: string;
  hint?: string;
  onBack: () => void;
  backLabel: string;
}) {
  return (
    <header className="screen-header guided-header">
      <div>
        {step !== undefined ? <GuidedProgress current={step} /> : <p className="text-eyebrow">{eyebrow}</p>}
        <h2 className="screen-header__title">{title}</h2>
        {hint && <p className="muted guided-hint">{hint}</p>}
      </div>
      <GuidedBackButton onBack={onBack} label={backLabel} />
    </header>
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
 * One direction card (§5 step 4) — the whole card is the tap target (no inner
 * "Välj" button: three primary buttons on one screen would mean none of them
 * reads as primary). The accessible name is set explicitly to the dish name
 * alone (`aria-label`), so `<button>`'s content model — which does not permit
 * a heading — stays valid: the dish name is a styled `<p>`, not an `<h3>`.
 * The summary, meta line and pantry match are wired in via
 * `aria-describedby` rather than left to the button's own text content,
 * which an explicit `aria-label` would otherwise hide from assistive tech
 * entirely. Cost is the shared three-dot meter with a Swedish accessible
 * label — a display-only rendering of the curated `cost_tier`, never the raw
 * enum and never an invented kronor figure (ARCHITECTURE §5.1).
 */
function DirectionCard({
  direction,
  onChoose,
  style,
}: {
  direction: GuidedDirection;
  onChoose: () => void;
  style?: CSSProperties;
}) {
  const covered = direction.ingredients.filter((ingredient) => ingredient.inPantry);
  const summaryId = useId();
  const metaId = useId();
  const coveredId = useId();
  const describedBy = [summaryId, metaId, covered.length > 0 ? coveredId : null]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className="card direction-card direction-card--enter"
      style={style}
      onClick={onChoose}
      aria-label={direction.template.name}
      aria-describedby={describedBy}
    >
      <p className="direction-card__name">{direction.template.name}</p>
      <p id={summaryId} className="direction-card__summary">
        {direction.summary}
      </p>
      <p id={metaId} className="direction-card__meta">
        {PREP_TIME_LABELS[direction.template.prep_time_band]}
        <span aria-hidden="true"> · </span>
        {costTierLabel(direction.template.cost_tier)}
      </p>
      {covered.length > 0 && (
        <p id={coveredId} className="direction-card__covered">
          Du har redan: {covered.map((ingredient) => ingredient.name).join(", ")}
        </p>
      )}
    </button>
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
      <p className="muted">Se över kostvalen i hushållet, så öppnar fler rätter upp sig.</p>
      <Button type="button" variant="primary" onClick={onRestart}>
        Börja om
      </Button>
    </Card>
  );
}

/** Placeholder chips at `.ingredient-grid`'s own cell size (#170) — stands in
 *  for step 2/3's grid while `fetchOptions` is in flight, so nothing jumps
 *  once the real ingredients land. */
function IngredientGridSkeleton() {
  return (
    <div className="ingredient-grid" aria-hidden="true">
      {Array.from({ length: 9 }, (_, index) => (
        <div key={index} className="skeleton-line skeleton-line--chip" />
      ))}
    </div>
  );
}

/** One placeholder `DirectionCard`, sized to its real content (name, two-line
 *  summary, meta) — no button row, since the card itself is the tap target now. */
function DirectionCardSkeleton() {
  return (
    <Card className="direction-card" aria-hidden="true">
      <div className="skeleton-line skeleton-line--direction-name" />
      <div className="skeleton-line skeleton-line--direction-summary" />
      <div className="skeleton-line skeleton-line--direction-summary-2" />
      <div className="skeleton-line skeleton-line--direction-meta" />
    </Card>
  );
}

/** Step 4's loading state (#170) — three placeholder cards, matching the real
 *  three-direction result exactly, standing in while `fetchDirections` runs. */
function DirectionListSkeleton() {
  return (
    <div className="direction-list" aria-hidden="true">
      <DirectionCardSkeleton />
      <DirectionCardSkeleton />
      <DirectionCardSkeleton />
    </div>
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
  const [error, setError] = useState<PresentedError | null>(null);
  // #133: set only around the "diner change after choosing" request below —
  // distinct from `loading`, which belongs to the "directions" step's own
  // fetch. Guards "Till inköpslistan": without it, the household could reach
  // the shopping list before a still-in-flight keep/replace check resolves,
  // landing `ShoppingList`'s one-time item snapshot on ingredients scaled for
  // whichever diner set wins the race rather than the one actually on screen.
  const [dinerChangePending, setDinerChangePending] = useState(false);
  // #231: the commit-time rescale request. Distinct from `dinerChangePending` — that
  // one guards a diner change that may replace the dish entirely, this one only
  // re-scales the dish already chosen — but both must resolve before a list is built.
  const [rescalePending, setRescalePending] = useState(false);
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
        // vegetarian member was away keeps offering meat as a tap target once she
        // is back at the table. The directions request would refuse it server-side, so
        // this is not a safety hole; it is the trap tap target the flow is built to
        // avoid.
        setOptions(null);
        setError(presentError(err, "guided_options"));
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
  // A miss falls back to the full grid rather than an empty one (requirement 1: the
  // grid stays visible and tappable at all times) — "no match" is communicated by
  // the message above it, never by the grid disappearing.
  const mainGridOptions =
    matchingMainIngredients.length > 0 ? matchingMainIngredients : (options?.mainIngredients ?? []);
  const noMainMatches = hasMainQuery && matchingMainIngredients.length === 0;

  const main = mainParameter(state);
  const pantryKey = state.pantry.join(",");
  const wantsDirections = state.step === "directions" && state.intent !== null && main !== null;

  // Set right before the "diner change after choosing" effect below dispatches
  // `dish_no_longer_safe` — that transition flips `wantsDirections` to true and
  // would otherwise make this effect re-fetch immediately with `keep` gone
  // (the choice was just released), silently overwriting the `replacedFor`
  // explanation the household is about to see with a plain, unexplained list.
  // One-shot: cleared the moment it suppresses a run, so every fetch this effect
  // is actually meant to make (arriving at "directions" any other way, or an
  // input changing while already there) still happens.
  const suppressNextDirectionsFetchRef = useRef(false);

  // Refetches whenever the inputs change, which is what makes the §9 loosen actions
  // work without their own request logic: they change `main` or the pantry and stay
  // on this step, so the effect below simply asks again.
  useEffect(() => {
    if (suppressNextDirectionsFetchRef.current) {
      suppressNextDirectionsFetchRef.current = false;
      return;
    }
    if (!wantsDirections || state.intent === null || main === null) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    client
      .fetchDirections({
        intent: state.intent,
        main,
        pantry: pantryKey.length > 0 ? pantryKey.split(",") : [],
        // #133: keep the already-chosen direction across a refetch (a diner
        // change, or a §9 loosen action) when the new constraints still allow
        // it — the same "keep or explain" contract Tonight's card uses.
        // `null` before a direction is chosen, same as every other request here.
        keep: state.chosenTemplateId ?? undefined,
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
        setError(presentError(err, "guided_directions"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, wantsDirections, state.intent, main, pantryKey, attempt]);

  /**
   * #133: a diner change *after* a direction is already chosen — the "portions"
   * and "shopping" steps, where the effect above never fires (`wantsDirections`
   * is false there by construction). A separate effect rather than widening that
   * one's condition: the "directions" step already refetches on every `client`
   * change through its own deps, and firing both here would double-request the
   * same diner change.
   *
   * Kept if the new constraints still allow it — `response` and `chosen` below
   * simply pick it up again, and the household never leaves "portions"/"shopping".
   * Replaced, and `dispatch`ed back to "directions" with the choice released, same
   * as stepping back manually — the fresh card set and `replacedFor` explanation
   * this same request already carries are what renders there (never a silent
   * swap). On failure the selection is put back, exactly like Tonight's card: the
   * picker must never show a diner set the chosen dish was never built for.
   */
  const requestedDinersRef = useRef(diners.parameter);
  const servedSelectionRef = useRef(diners.selection);
  useEffect(() => {
    if (requestedDinersRef.current === diners.parameter) return;

    // `requestedDinersRef` is updated unconditionally, even when there is
    // nothing chosen yet to keep — a diner toggle taken before choosing (owned
    // by the "directions" step's own effect above, via its `client` dependency)
    // must still count as "considered" here, or a later toggle back to this
    // same set would look like a no-op to *this* effect. `servedSelectionRef`
    // is different: it must only ever hold a diner set this effect actually
    // confirmed safe (set in the `.then()` below), never one merely attempted —
    // a failed request's rollback restores *that*, and restoring an
    // unconfirmed set would be the exact bug this effect exists to avoid.
    const previousParameter = requestedDinersRef.current;
    const previousSelection = servedSelectionRef.current;
    const attempted = diners.selection;
    requestedDinersRef.current = diners.parameter;

    if (state.chosenTemplateId === null || state.intent === null || main === null) {
      // No request to make — the "directions" step's own effect (or nothing at
      // all, pre-choice) already owns this diner change, so there is nothing
      // for this effect to confirm. Safe to record as served immediately: no
      // async request from here can later fail and need to roll it back.
      servedSelectionRef.current = attempted;
      return;
    }

    const chosenTemplateId = state.chosenTemplateId;
    const intent = state.intent;

    let cancelled = false;
    setDinerChangePending(true);
    client
      .fetchDirections({
        intent,
        main,
        pantry: pantryKey.length > 0 ? pantryKey.split(",") : [],
        keep: chosenTemplateId,
      })
      .then((loaded) => {
        if (cancelled) return;
        setResponse(loaded);
        servedSelectionRef.current = attempted;
        const stillChosen = loaded.directions.some((direction) => direction.template.id === chosenTemplateId);
        if (!stillChosen) {
          // Unconditional: this diner control only ever reaches the "portions"
          // step now (the "shopping" step has none, precisely to keep a saved
          // list's quantities from going stale under it — see that step's own
          // comment), so no list for this dish can exist yet in the ordinary
          // case. Clearing anyway costs nothing when there is nothing to clear,
          // and forecloses the alternative: a household that raced ahead to
          // "Till inköpslistan" while this request was still in flight leaving a
          // list behind for a dish just found unsafe, for a reload to resume
          // straight into with no safety re-check (#133).
          clearShoppingList();
          suppressNextDirectionsFetchRef.current = true;
          dispatch({ type: "dish_no_longer_safe" });
        } else {
          // Kept, but the diner set's total may not be what the stepper still
          // shows — `loaded.portions` is what the server actually scaled these
          // ingredients for, so the displayed count has to match it exactly,
          // the same way `choose_direction` always reseeds from a fresh number
          // rather than carrying one over from a dish the household left behind.
          dispatch({ type: "portions_rescaled", portions: loaded.portions });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(presentError(err, "guided_diner_change"));
        requestedDinersRef.current = previousParameter;
        diners.restore(previousSelection);
      })
      .finally(() => {
        if (!cancelled) setDinerChangePending(false);
      });

    return () => {
      cancelled = true;
    };
    // Deliberately keyed on the diner set alone, matching the effect above's own
    // rule: this must fire when who is eating changes and at no other time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diners.parameter]);

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
    if (isFirstStep(state)) {
      onExit();
      return;
    }
    // A stale error describes a request tied to the step being left, same as a
    // failed refetch drops its stale response elsewhere in this file — going
    // back must not strand the household staring at an error the current step
    // no longer explains.
    setError(null);
    dispatch({ type: "back" });
  }

  /**
   * #231: commit the stepper's portion count.
   *
   * The stepper used to move a number and nothing else — the ingredients stayed
   * scaled to whatever the *diner set* worked out to, so a household that stepped 2
   * up to 6 got a list headed "6 portioner" with amounts for 2. The count and the
   * amounts have to come from one scaling, and that scaling belongs on the server:
   * the rounding rules live in `src/engine/quantities.ts`, and re-deriving them in
   * the client would be a second, quietly wrong definition of the same thing.
   *
   * So the dish is refetched at the chosen count before the list is built — once, at
   * commit, not once per tap of "+". `keep` is what makes that safe: it is the same
   * contract #133 uses, so the request returns *this* dish rather than re-rolling the
   * three cards under a household that has already chosen.
   *
   * Skipped entirely when the count already matches what the response was scaled for,
   * which is the common path: most households never touch the stepper.
   */
  async function handleConfirmPortions() {
    const scaledFor = response?.portions;
    if (
      state.portions === null ||
      scaledFor === undefined ||
      state.portions === scaledFor ||
      state.chosenTemplateId === null ||
      state.intent === null ||
      main === null
    ) {
      dispatch({ type: "confirm_portions" });
      return;
    }

    setRescalePending(true);
    setError(null);
    try {
      const loaded = await client.fetchDirections({
        intent: state.intent,
        main,
        pantry: pantryKey.length > 0 ? pantryKey.split(",") : [],
        keep: state.chosenTemplateId,
        portions: state.portions,
      });
      setResponse(loaded);
      // The server's answer, not the request: it clamps, and the count on screen must
      // name what the amounts below it were actually scaled to.
      dispatch({ type: "portions_rescaled", portions: loaded.portions });
      dispatch({ type: "confirm_portions" });
    } catch (err: unknown) {
      // Stays on this step rather than building a list from the amounts it already
      // has: those are scaled for a different number than the one on screen, which is
      // precisely the state this whole function exists to prevent.
      setError(presentError(err, "guided_directions"));
    } finally {
      setRescalePending(false);
    }
  }

  const backLabel = isFirstStep(state) ? "Till ikväll" : "Tillbaka";

  return (
    <div className="guided-flow">
      {error ? (
        <>
          {/* Replaces the step's own content rather than stacking above it (#170)
              — the back button is the one piece of step chrome that survives, so
              a broken request never strands the household without a way out. */}
          <div className="guided-header guided-header--error">
            <GuidedBackButton onBack={handleBack} label={backLabel} />
          </div>
          <StateScreen
            variant="solid"
            role={error.kind === "offline" ? "status" : "alert"}
            title={error.kind === "offline" ? "Ingen anslutning" : "Något gick fel"}
            body={
              error.kind === "offline"
                ? "Anslut till internet och försök igen."
                : "Försök igen om en liten stund."
            }
            action={{
              label: "Försök igen",
              onClick: () => {
                setError(null);
                setAttempt((n) => n + 1);
              },
            }}
            reference={error.kind === "error" ? error.code : undefined}
          />
        </>
      ) : (
        <>
          {state.step === "intent" && (
            <>
              <GuidedStepHeader
                step={1}
                title="Vad är du sugen på?"
                onBack={handleBack}
                backLabel={backLabel}
              />
              <div className="guided-step-body">
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
              </div>
            </>
          )}

          {state.step === "main" && (
            <>
              <GuidedStepHeader
                step={2}
                title="Vilken huvudingrediens?"
                hint="Välj en, eller låt oss föreslå utifrån säsong och pris."
                onBack={handleBack}
                backLabel={backLabel}
              />
              <div className="guided-step-body">
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
                  {noMainMatches && <p className="muted" role="status">Ingen träff.</p>}
                  <IngredientGrid
                    label="Huvudingredienser"
                    options={mainGridOptions}
                    onTap={(ingredientId) => dispatch({ type: "select_main", ingredientId })}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    className="guided-quiet-action"
                    onClick={() => dispatch({ type: "suggest_main" })}
                  >
                    Föreslå åt mig
                  </Button>
                </>
              ) : (
                <>
                  <p className="muted sr-only">Hämtar ingredienser…</p>
                  <IngredientGridSkeleton />
                </>
              )}
              </div>
            </>
          )}

          {state.step === "pantry" && (
            <>
              <GuidedStepHeader
                step={3}
                title="Vad har du hemma?"
                hint="Valfritt — vi använder det bara för att välja förslag, och sparar det inte."
                onBack={handleBack}
                backLabel={backLabel}
              />
              {options ? (
                <>
                  {/* #206: the same component Tonight's "Fler" sheet renders. This
                      step used to show 18 chips flat with no way to narrow them,
                      while the sheet showing the identical list looked different. */}
                  <PantryPicker
                    options={options.pantryIngredients}
                    selected={state.pantry}
                    onToggle={(ingredientId) => dispatch({ type: "toggle_pantry", ingredientId })}
                    label="Varor hemma"
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
                <>
                  <p className="muted sr-only">Hämtar ingredienser…</p>
                  <IngredientGridSkeleton />
                </>
              )}
            </>
          )}

          {state.step === "directions" && (
            <>
              <GuidedStepHeader
                eyebrow="Förslag"
                title="Tre förslag"
                onBack={handleBack}
                backLabel={backLabel}
              />
              {/* #133: only when a chosen direction had to be dropped from this list —
                  same "never a silent swap" contract as Tonight's card. */}
              {!loading && response?.replacedFor && (
                <p role="status" className="diner-replaced-notice">
                  {dinerChangeReasonLine(response.replacedFor)}
                </p>
              )}
              {loading && (
                <>
                  <p className="muted sr-only">Hämtar förslag…</p>
                  <DirectionListSkeleton />
                </>
              )}
              {!loading && response && response.directions.length > 0 && (
                <div className="direction-list">
                  {response.directions.map((direction, index) => (
                    <DirectionCard
                      key={direction.template.id}
                      direction={direction}
                      style={{ animationDelay: `${index * 70}ms` }}
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
              <GuidedStepHeader
                eyebrow="Portioner"
                title="Hur många portioner?"
                onBack={handleBack}
                backLabel={backLabel}
              />
              {/* #133: the chosen dish is a refinement target here too — kept when the
                  new diner set still allows it, replaced (never silently) when not. */}
              <DinerPicker state={diners} busy={dinerChangePending} />
              <Card className="portions-card">
                <h3 className="portions-card__dish">{chosen.template.name}</h3>
                <div className="portions-stepper">
                  <button
                    type="button"
                    className="portions-stepper__btn"
                    aria-label="Färre portioner"
                    disabled={state.portions <= MIN_PORTIONS}
                    onClick={() => dispatch({ type: "adjust_portions", delta: -1 })}
                  >
                    −
                  </button>
                  <span role="status" className="portions-value">
                    <span className="portions-value__word">För</span>{" "}
                    <span className="portions-value__count">
                      {formatPortionsCount(state.portions)}
                    </span>{" "}
                    <span className="portions-value__word">{portionsNoun(state.portions)}</span>
                  </span>
                  <button
                    type="button"
                    className="portions-stepper__btn"
                    aria-label="Fler portioner"
                    // #231: the route clamps to the same ceiling, so without this the
                    // stepper could ask for a number the server would silently answer
                    // with a different one.
                    disabled={state.portions >= MAX_PORTIONS}
                    onClick={() => dispatch({ type: "adjust_portions", delta: 1 })}
                  >
                    +
                  </button>
                </div>
                <Button
                  type="button"
                  variant="primary"
                  onClick={handleConfirmPortions}
                  className="guided-action"
                  // #133: a still-in-flight keep/replace check must resolve before the
                  // shopping list is built — it can still change which dish (and which
                  // portions) "the chosen dish" even means.
                  // #231: likewise the rescale request, which decides the amounts the
                  // list is about to be built from.
                  disabled={dinerChangePending || rescalePending}
                >
                  Till inköpslistan
                </Button>
              </Card>
            </>
          )}

          {state.step === "shopping" && meal && (
            <>
              <GuidedStepHeader
                eyebrow="Inköpslista"
                title="Inköpslista"
                onBack={handleBack}
                backLabel={backLabel}
              />
              {/* No diner picker here, deliberately, matching Tonight's own card
                  (#133): `ShoppingList` reads its items into state once at mount and
                  never rescales them from a later `portions`/`ingredients` change, so
                  a diner toggle at this step could only move the header's count out
                  of sync with the list underneath it — same reason Tonight's own
                  picker is never rendered once its shopping list is on screen. */}
              <ShoppingList
                result={meal}
                explanation={chosen?.summary}
                portions={state.portions ?? undefined}
                diners={diners.parameter}
                accessToken={accessToken}
                onNewSuggestion={() => dispatch({ type: "restart" })}
                newSuggestionLabel="Börja om"
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
