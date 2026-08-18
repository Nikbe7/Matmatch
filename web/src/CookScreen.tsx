import { useEffect, useState } from "react";
import type { PrepTimeBand } from "../../src/schema/recipeTemplate";
import { fetchInstructions, type TonightSubstitution } from "./api";
import {
  loadCookRecord,
  saveCookRecord,
  substitutionKey,
  type CookIngredient,
} from "./instructionsStorage";
import { formatPortions, formatQuantity, PREP_TIME_LABELS } from "./display";
import { presentError, GENERIC_ERROR_MESSAGE, OFFLINE_MESSAGE } from "./errorPresentation";
import { Button } from "./components/Button";
import { StateScreen } from "./components/StateScreen";
import { useWakeLock } from "./useWakeLock";

// The cook screen (#154). One job: to be read one-handed, in a kitchen, while
// something is on the stove. One step dominates; the rest of the recipe is present
// but quiet, and the ingredient list is one tap away without competing for the
// same space.
//
// The division of labour is the same one the whole app runs on, and it is visible
// in this file: every number here — amounts, portions, the prep-time band — arrives
// as curated data already scaled by the Meal Engine, and the *only* thing that came
// from a model is the prose inside `steps`. Nothing on this screen is computed from
// that prose. In particular the time in the metadata row is the template's curated
// `prep_time_band` and is never summed from the minute counts a step happens to
// mention (DECISION_LOG).

/** What the screen needs about the dish, all of it curated or engine-computed. */
export interface CookMeal {
  templateId: string;
  name: string;
  /** Curated band, never derived from step prose. Absent on a dish resumed from an
   *  older stored shopping list, in which case the row simply omits the time rather
   *  than estimating one. */
  prepTimeBand?: PrepTimeBand;
  portions?: number;
  ingredients: CookIngredient[];
  substitutions: TonightSubstitution[];
}

type StepsState =
  | { status: "generating" }
  | { status: "ready"; steps: string[]; fromCache: boolean }
  // `offline` is distinct from `error`: one is "we could not reach the server",
  // which a household in a kitchen can do nothing about and does not need a retry
  // button framed as a fix, the other is a failure worth retrying.
  | { status: "offline" }
  | { status: "error"; message: string };

function MetaRow({ meal }: { meal: CookMeal }) {
  const parts: string[] = [];
  if (meal.prepTimeBand) parts.push(PREP_TIME_LABELS[meal.prepTimeBand]);
  if (meal.portions !== undefined) parts.push(formatPortions(meal.portions));
  if (parts.length === 0) return null;

  return (
    <p className="cook__meta">
      {parts.map((part, index) => (
        <span key={part}>
          {index > 0 && <span className="cook__meta-separator" aria-hidden="true"> · </span>}
          {part}
        </span>
      ))}
    </p>
  );
}

/**
 * The ingredient list, present but not competing (#154): a native `<details>`,
 * open by default, so it collapses out of the way with one tap and needs no
 * JavaScript, no focus management and no ARIA of our own to be accessible.
 */
function IngredientPanel({
  ingredients,
  onShoppingList,
}: {
  ingredients: readonly CookIngredient[];
  onShoppingList: () => void;
}) {
  if (ingredients.length === 0) return null;

  return (
    <details className="cook__ingredients" open>
      <summary className="cook__ingredients-summary">
        <span className="text-eyebrow">Ingredienser</span>
        <span className="cook__ingredients-count">{ingredients.length}</span>
      </summary>
      <ul className="cook__ingredient-list">
        {ingredients.map((ingredient) => (
          <li key={ingredient.name} className="cook__ingredient-row">
            <span className="cook__ingredient-name">{ingredient.name}</span>
            <span className="item-amount">{formatQuantity(ingredient.quantity)}</span>
          </li>
        ))}
      </ul>
      <Button type="button" variant="secondary" onClick={onShoppingList}>
        Till inköpslistan
      </Button>
    </details>
  );
}

function StepList({
  steps,
  activeIndex,
  onSelect,
}: {
  steps: readonly string[];
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  return (
    <ol className="cook__steps">
      {steps.map((step, index) => {
        const active = index === activeIndex;
        const done = index < activeIndex;
        const className = ["cook__step", active && "cook__step--active", done && "cook__step--done"]
          .filter(Boolean)
          .join(" ");

        return (
          <li key={index} className={className}>
            <button
              type="button"
              className="cook__step-button"
              onClick={() => onSelect(index)}
              aria-current={active ? "step" : undefined}
            >
              <span className="cook__step-number" aria-hidden="true">
                {index + 1}
              </span>
              <span className="cook__step-text">{step}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function CookScreen({
  meal,
  accessToken,
  onBack,
  onShoppingList,
}: {
  meal: CookMeal;
  accessToken: string;
  onBack: () => void;
  onShoppingList: () => void;
}) {
  // Read synchronously on first render, not in an effect: a household that has
  // cooked this dish before should never see a loading state it does not need, and
  // an effect would flash "Skapar instruktioner…" for one frame before replacing it.
  const [state, setState] = useState<StepsState>(() => {
    const stored = loadCookRecord(meal.templateId, meal.substitutions);
    return stored ? { status: "ready", steps: stored.steps, fromCache: true } : { status: "generating" };
  });
  const [attempt, setAttempt] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);

  // Only while there is something to read — no point holding the screen awake
  // through a failed generation.
  useWakeLock(state.status === "ready");

  useEffect(() => {
    if (state.status === "ready") return;

    let cancelled = false;
    setState({ status: "generating" });

    fetchInstructions(accessToken, meal.templateId, meal.substitutions)
      .then((response) => {
        if (cancelled) return;
        if (!response.instructions) {
          setState({ status: "error", message: GENERIC_ERROR_MESSAGE });
          return;
        }
        setState({ status: "ready", steps: response.instructions, fromCache: false });
        // Written only on a successful generation, so a failed one never leaves a
        // half-record that would suppress the next attempt's fetch.
        saveCookRecord({
          version: 1,
          templateId: meal.templateId,
          substitutionKey: substitutionKey(meal.substitutions),
          substitutions: [...meal.substitutions],
          name: meal.name,
          prepTimeBand: meal.prepTimeBand,
          portions: meal.portions,
          ingredients: meal.ingredients,
          steps: response.instructions,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const presented = presentError(err, "instructions");
        setState(
          presented.kind === "offline"
            ? { status: "offline" }
            : { status: "error", message: GENERIC_ERROR_MESSAGE },
        );
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, meal.templateId, attempt]);

  const steps = state.status === "ready" ? state.steps : [];
  const onLastStep = activeIndex >= steps.length - 1;

  return (
    <div className="cook">
      <button type="button" className="cook__back" onClick={onBack}>
        ← Ikväll
      </button>

      <h2 className="cook__title">{meal.name}</h2>
      <MetaRow meal={meal} />

      <IngredientPanel ingredients={meal.ingredients} onShoppingList={onShoppingList} />

      <section className="cook__section">
        <h3 className="text-eyebrow">Så gör du</h3>

        {state.status === "generating" && (
          <p className="muted" role="status">
            Skapar instruktioner…
          </p>
        )}

        {state.status === "offline" && (
          <p className="muted" role="status">
            {OFFLINE_MESSAGE}
          </p>
        )}

        {state.status === "error" && (
          <div className="cook__error">
            <p role="alert">{state.message}</p>
            <Button type="button" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
              Försök igen
            </Button>
          </div>
        )}

        {state.status === "ready" && (
          <>
            <StepList steps={steps} activeIndex={activeIndex} onSelect={setActiveIndex} />
            {onLastStep ? (
              <Button type="button" variant="primary" onClick={onBack}>
                Middagen är klar
              </Button>
            ) : (
              <Button
                type="button"
                variant="primary"
                onClick={() => setActiveIndex((index) => index + 1)}
              >
                Klar med steg {activeIndex + 1}
              </Button>
            )}
          </>
        )}
      </section>
    </div>
  );
}

/**
 * Reached with no dish to cook — a bookmarked `/laga/:id` opened cold, or a device
 * whose stored list is for a different dish. One way out, matching `/lista`'s own
 * empty state rather than inventing a second vocabulary for "nothing here yet".
 */
export function CookScreenEmpty({ onBack }: { onBack: () => void }) {
  return (
    <StateScreen
      variant="dashed"
      role="status"
      title="Ingen middag att laga"
      body="Välj kvällens middag först, så visar vi ingredienserna och stegen här."
      action={{ label: "Se förslag för ikväll", onClick: onBack }}
    />
  );
}
