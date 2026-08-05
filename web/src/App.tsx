import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabaseClient";
import { ApiError, createHousehold, fetchTonight, type TonightResponse, type TonightResult } from "./api";
import { ALLERGIES, DIETARY_FLAGS, type Allergy, type DietaryFlag } from "../../src/schema/vocabulary";
import type { Household, HouseholdMember, HouseholdMemberType } from "../../src/schema/household";
import type { CostTier } from "../../src/schema/ingredient";
import type { IngredientSlotRole, PrepTimeBand } from "../../src/schema/recipeTemplate";
import { ShoppingList } from "./ShoppingList";
import { loadShoppingList } from "./shoppingListStorage";

// One screen, four states: signed out (login form), household unknown (loading),
// no household (onboarding), household exists (Tonight view). This slice is a
// wire, not a screen — no router, no component library, no styling beyond browser
// defaults.

export const ALLERGY_LABELS: Record<Allergy, string> = {
  gluten: "Gluten",
  dairy_lactose: "Mjölk/laktos",
  egg: "Ägg",
  tree_nuts: "Trädnötter",
  peanuts: "Jordnötter",
  shellfish: "Skaldjur",
  fish: "Fisk",
  soy: "Soja",
};

export const DIETARY_FLAG_LABELS: Record<DietaryFlag, string> = {
  vegetarian: "Vegetariskt",
  vegan: "Veganskt",
  high_protein_preference: "Proteinrikt",
};

// Display-only mapping (DECISION_LOG 2026-07-29, amended for the dot meter): the
// dots are never the underlying cost_tier value and never stand in for an invented
// kronor figure. An exhaustive switch means a new tier value fails typecheck here
// rather than silently rendering nothing.
export function costTierMeter(tier: CostTier): string {
  switch (tier) {
    case "budget":
      return "●○○";
    case "mid":
      return "●●○";
    case "premium":
      return "●●●";
    default: {
      const exhaustive: never = tier;
      return exhaustive;
    }
  }
}

// The dot meter is purely visual — a screen reader must announce this word, not
// three bullet characters, so the card wires this in as an aria-label rather than
// relying on the dot string's own accessible name.
export function costTierLabel(tier: CostTier): string {
  switch (tier) {
    case "budget":
      return "Billig";
    case "mid":
      return "Mellan";
    case "premium":
      return "Dyr";
    default: {
      const exhaustive: never = tier;
      return exhaustive;
    }
  }
}

const PREP_TIME_LABELS: Record<PrepTimeBand, string> = {
  "<20min": "Under 20 min",
  "20-40min": "20–40 min",
  "40min+": "Över 40 min",
};

const INGREDIENT_ROLE_LABELS: Record<IngredientSlotRole, string> = {
  protein: "Protein",
  starch: "Stärkelse",
  vegetable: "Grönsak",
  aromatic: "Arom",
  dairy: "Mejeri",
};

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSignIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) setError(signInError.message);
    setBusy(false);
  }

  async function handleSignUp() {
    setBusy(true);
    setError(null);
    const { error: signUpError } = await supabase.auth.signUp({ email, password });
    if (signUpError) setError(signUpError.message);
    setBusy(false);
  }

  return (
    <form onSubmit={handleSignIn}>
      <h1>Matmatch</h1>
      <div>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
      </div>
      <div>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={6}
          />
        </label>
      </div>
      <button type="submit" disabled={busy}>
        Sign in
      </button>
      <button type="button" disabled={busy} onClick={handleSignUp}>
        Sign up
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

function toggleValue<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

// aria-pressed alone carries no default browser styling — a selected chip must be
// visibly distinct, not just programmatically marked, for a tap-first UI.
function chipStyle(pressed: boolean): CSSProperties {
  return pressed
    ? { fontWeight: "bold", background: "#333", color: "#fff" }
    : { fontWeight: "normal" };
}

function emptyMember(type: HouseholdMemberType): HouseholdMember {
  return { type, portion_factor: type === "adult" ? 1 : 0.5 };
}

function OnboardingForm({
  session,
  onCreated,
}: {
  session: Session;
  onCreated: () => void;
}) {
  const [members, setMembers] = useState<HouseholdMember[]>([emptyMember("adult")]);
  const [allergies, setAllergies] = useState<Allergy[]>([]);
  const [dietaryFlags, setDietaryFlags] = useState<DietaryFlag[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function updateMember(index: number, patch: Partial<HouseholdMember>) {
    setMembers((current) =>
      current.map((member, i) => (i === index ? { ...member, ...patch } : member)),
    );
  }

  function addMember() {
    setMembers((current) => [...current, emptyMember("adult")]);
  }

  function removeMember(index: number) {
    setMembers((current) => current.filter((_, i) => i !== index));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const household: Household = { members, allergies, dietary_flags: dietaryFlags };
    try {
      await createHousehold(session.access_token, household);
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <h2>Skapa hushåll</h2>
      <fieldset>
        <legend>Medlemmar</legend>
        {members.map((member, index) => (
          <div key={index}>
            <label>
              Typ
              <select
                value={member.type}
                onChange={(event) =>
                  updateMember(index, { type: event.target.value as HouseholdMemberType })
                }
              >
                <option value="adult">Vuxen</option>
                <option value="child">Barn</option>
              </select>
            </label>
            <label>
              Portionsstorlek
              <input
                type="number"
                step="0.1"
                min="0.1"
                value={member.portion_factor}
                onChange={(event) =>
                  updateMember(index, { portion_factor: Number(event.target.value) })
                }
                required
              />
            </label>
            <button type="button" onClick={() => removeMember(index)} disabled={members.length <= 1}>
              Ta bort
            </button>
          </div>
        ))}
        <button type="button" onClick={addMember}>
          Lägg till medlem
        </button>
      </fieldset>

      <fieldset>
        <legend>Kostpreferenser</legend>
        {DIETARY_FLAGS.map((flag) => (
          <button
            type="button"
            key={flag}
            aria-pressed={dietaryFlags.includes(flag)}
            style={chipStyle(dietaryFlags.includes(flag))}
            onClick={() => setDietaryFlags((current) => toggleValue(current, flag))}
          >
            {DIETARY_FLAG_LABELS[flag]}
          </button>
        ))}
      </fieldset>

      <fieldset>
        <legend>Allergier</legend>
        {ALLERGIES.map((allergy) => (
          <button
            type="button"
            key={allergy}
            aria-pressed={allergies.includes(allergy)}
            style={chipStyle(allergies.includes(allergy))}
            onClick={() => setAllergies((current) => toggleValue(current, allergy))}
          >
            {ALLERGY_LABELS[allergy]}
          </button>
        ))}
      </fieldset>

      <button type="submit" disabled={busy}>
        Spara hushåll
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

function SuggestionCard({
  result,
  onAccept,
  onNextSuggestion,
  fetchingNext,
}: {
  result: TonightResult;
  onAccept: () => void;
  onNextSuggestion: () => void;
  fetchingNext: boolean;
}) {
  return (
    <div>
      <h3>{result.template.name}</h3>
      <p>
        <span role="img" aria-label={costTierLabel(result.template.cost_tier)}>
          <span aria-hidden="true">{costTierMeter(result.template.cost_tier)}</span>
        </span>{" "}
        · {PREP_TIME_LABELS[result.template.prep_time_band]}
      </p>
      <ul>
        {result.ingredients.map((ingredient, index) => (
          <li key={index}>
            {INGREDIENT_ROLE_LABELS[ingredient.role]}: {ingredient.name}
            {ingredient.substituted ? " (ersättning)" : ""}
          </li>
        ))}
      </ul>
      <button type="button" onClick={onAccept}>
        Acceptera
      </button>
      <button type="button" onClick={onNextSuggestion} disabled={fetchingNext}>
        Nytt förslag
      </button>
      {fetchingNext && <p>Hämtar…</p>}
    </div>
  );
}

type TonightViewState = { status: "suggestion" } | { status: "shopping" };

function TonightView({ data, accessToken }: { data: TonightResponse; accessToken: string }) {
  const initialResult = data.result;

  // A page reload in the shop must land back on the shopping list, not the
  // suggestion card — so the initial state checks for a stored list matching this
  // result's template id, once, at mount. TonightView is remounted fresh by Gate
  // on every "ready" transition (see Gate below), so this lazy initializer always
  // sees the current result.
  const [state, setState] = useState<TonightViewState>(() =>
    initialResult !== null && loadShoppingList(initialResult.template.id)
      ? { status: "shopping" }
      : { status: "suggestion" },
  );

  // "Nytt förslag" cycling state — React state only, per CLAUDE.md's session-scoped
  // rule for ephemeral input: nothing here touches localStorage or the URL, so a
  // reload starts fresh (a fresh `data` prop from a remounted TonightView, too).
  const [current, setCurrent] = useState<TonightResponse>(data);
  const [shownTemplateIds, setShownTemplateIds] = useState<string[]>(
    initialResult ? [initialResult.template.id] : [],
  );
  const [fetchingNext, setFetchingNext] = useState(false);
  const [nextError, setNextError] = useState<string | null>(null);

  async function requestNext(exclude: readonly string[]) {
    setFetchingNext(true);
    setNextError(null);
    try {
      const next = await fetchTonight(accessToken, { exclude, previous: current.result?.template.id });
      setCurrent(next);
      if (next.result) setShownTemplateIds((ids) => [...ids, next.result!.template.id]);
    } catch (err) {
      setNextError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setFetchingNext(false);
    }
  }

  function handleReset() {
    setShownTemplateIds([]);
    void requestNext([]);
  }

  const result = current.result;

  return (
    <div>
      <h2>Ikväll</h2>
      {nextError && <p role="alert">{nextError}</p>}
      {result === null && current.reason === "no_more_suggestions" && (
        <div>
          <p>Du har sett allt vi har för ikväll</p>
          <button type="button" onClick={handleReset} disabled={fetchingNext}>
            Börja om
          </button>
        </div>
      )}
      {result === null && current.reason !== "no_more_suggestions" && (
        <pre>{`no result: ${current.reason}`}</pre>
      )}
      {result !== null && state.status === "suggestion" && (
        <SuggestionCard
          result={result}
          onAccept={() => setState({ status: "shopping" })}
          onNextSuggestion={() => void requestNext(shownTemplateIds)}
          fetchingNext={fetchingNext}
        />
      )}
      {result !== null && state.status === "shopping" && (
        <ShoppingList
          result={result}
          portions={current.portions}
          onNewSuggestion={() => setState({ status: "suggestion" })}
        />
      )}
    </div>
  );
}

type GateState =
  | { status: "checking" }
  | { status: "no_household" }
  | { status: "ready"; data: TonightResponse }
  | { status: "error"; code: string; message: string };

function toGateState(error: unknown): GateState {
  if (error instanceof ApiError) {
    if (error.code === "household_not_found") return { status: "no_household" };
    return { status: "error", code: error.code, message: error.message };
  }
  return { status: "error", code: "network_error", message: String(error) };
}

function Gate({ session }: { session: Session }) {
  const [state, setState] = useState<GateState>({ status: "checking" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "checking" });

    fetchTonight(session.access_token)
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState(toGateState(error));
      });

    return () => {
      cancelled = true;
    };
  }, [session.access_token]);

  function handleCreated() {
    // The household now exists but we don't have a Tonight response for it yet —
    // one fresh fetch, the same call the initial load makes, not a second probe.
    setState({ status: "checking" });
    fetchTonight(session.access_token)
      .then((data) => setState({ status: "ready", data }))
      .catch((error: unknown) => setState(toGateState(error)));
  }

  return (
    <div>
      <p>
        Signed in as {session.user.email}{" "}
        <button type="button" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </p>
      {state.status === "checking" && <p>Loading…</p>}
      {state.status === "error" && <pre>{`error: ${state.code}\n${state.message}`}</pre>}
      {state.status === "no_household" && (
        <OnboardingForm session={session} onCreated={handleCreated} />
      )}
      {state.status === "ready" && <TonightView data={state.data} accessToken={session.access_token} />}
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (session === undefined) return <p>Loading…</p>;
  if (session === null) return <LoginForm />;
  return <Gate session={session} />;
}
