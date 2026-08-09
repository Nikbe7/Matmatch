import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabaseClient";
import {
  ApiError,
  createHousehold,
  fetchTonight,
  markCooked,
  type TonightResponse,
  type TonightResult,
} from "./api";
import { ALLERGIES, DIETARY_FLAGS, type Allergy, type DietaryFlag } from "../../src/schema/vocabulary";
import {
  MEMBER_NAME_MAX_LENGTH,
  memberLabels,
  type Household,
  type HouseholdMember,
  type HouseholdMemberType,
} from "../../src/schema/household";
import {
  costTierLabel,
  costTierMeter,
  INGREDIENT_ROLE_LABELS,
  PREP_TIME_LABELS,
} from "./display";
import { GuidedFlow } from "./GuidedFlow";
import { OfflineShoppingList, ShoppingList } from "./ShoppingList";
import {
  loadAnyShoppingList,
  loadShoppingList,
  type StoredShoppingList,
} from "./shoppingListStorage";
import { setAnalyticsSink, track } from "./analytics";
import { createHttpAnalyticsSink } from "./analyticsSink";
import { Button } from "./components/Button";
import { Card } from "./components/Card";
import { Chip } from "./components/Chip";
import {
  INITIAL_REFINEMENT,
  MAX_WEIGHT_LEVEL,
  refinementReducer,
  searchOtherCuisine,
  weightLevel,
  type ChipId,
  type RefinementAction,
  type RefinementState,
  type WeightAxis,
} from "./refinement";

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

// Re-exported so existing consumers (and tests) keep importing these from App,
// while the guided flow can import them without the two modules importing each
// other. The definitions live in display.ts.
export { costTierLabel, costTierMeter, INGREDIENT_ROLE_LABELS, PREP_TIME_LABELS };

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
    <Card>
      <form onSubmit={handleSignIn}>
        <h1>Matmatch</h1>
        <div className="field">
          <label>
            Email
            <input
              className="input"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
        </div>
        <div className="field">
          <label>
            Password
            <input
              className="input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={6}
            />
          </label>
        </div>
        <Button type="submit" variant="primary" disabled={busy}>
          Sign in
        </Button>{" "}
        <Button type="button" variant="secondary" disabled={busy} onClick={handleSignUp}>
          Sign up
        </Button>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
      </form>
    </Card>
  );
}

function toggleValue<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function emptyMember(type: HouseholdMemberType): HouseholdMember {
  return {
    type,
    portion_factor: type === "adult" ? 1 : 0.5,
    // Explicitly empty, never omitted: HouseholdMemberSchema requires both arrays so
    // that an unset safety value cannot be mistaken for a declared-empty one, and the
    // form must satisfy that rather than lean on a default that does not exist.
    allergies: [],
    dietary_flags: [],
  };
}

/**
 * One member's own row of the profile form (#115).
 *
 * A stacked block rather than a flat row: since constraints moved onto members, a
 * member carries a name, a type, a portion factor, three dietary chips and eight
 * allergy chips, and there is no honest way to fit that on one line at 360px. It is
 * still one screen and one form — the alternative (a step per member) would turn
 * onboarding into the wizard UX_FLOW §3 is explicit about avoiding.
 *
 * Allergies keep their own bordered, differently-labelled fieldset inside the member
 * block, exactly as they had at household level (#101, UX_FLOW §6). Flattening the
 * two chip groups into one row per member would have been the easy way to save
 * vertical space and is precisely the regression that must not happen: a preference
 * and a safety constraint have to stay tellable apart at a glance.
 */
function MemberFields({
  member,
  label,
  fallbackLabel,
  index,
  onChange,
  onRemove,
  removable,
}: {
  member: HouseholdMember;
  /** How this member is shown right now — their name if they have one. */
  label: string;
  /** What blank would produce. Distinct from `label`: for a named member the hint
   *  still has to say what clearing the field gets you, not repeat their name back. */
  fallbackLabel: string;
  index: number;
  onChange: (patch: Partial<HouseholdMember>) => void;
  onRemove: () => void;
  removable: boolean;
}) {
  const nameId = `member-${index}-name`;
  const nameHintId = `member-${index}-name-hint`;

  return (
    <div className="member-card">
      <div className="member-card-header">
        <h3 className="member-card-title">{label}</h3>
        <Button type="button" variant="destructive" onClick={onRemove} disabled={!removable}>
          Ta bort
        </Button>
      </div>

      <div className="member-row">
        <div className="field member-field-name">
          <label htmlFor={nameId}>Namn</label>
          <input
            id={nameId}
            className="input"
            type="text"
            maxLength={MEMBER_NAME_MAX_LENGTH}
            value={member.name ?? ""}
            // Never `required`, and no validation state: blank is a supported answer,
            // not an incomplete one. The hint below says what blank produces so an
            // empty field reads as a choice rather than as something left undone.
            // Just "Valfritt": anything longer is truncated by the field at 360px, and
            // the hint below carries the explanation where it has room to be read.
            placeholder="Valfritt"
            aria-describedby={nameHintId}
            onChange={(event) => onChange({ name: event.target.value })}
          />
          <p id={nameHintId} className="field-hint">
            Lämna tomt så visas ”{fallbackLabel}”.
          </p>
        </div>
        <label className="field member-field-type">
          Typ
          <select
            className="input"
            value={member.type}
            onChange={(event) => onChange({ type: event.target.value as HouseholdMemberType })}
          >
            <option value="adult">Vuxen</option>
            <option value="child">Barn</option>
          </select>
        </label>
        <label className="field member-field-portion">
          Portionsstorlek
          <input
            className="input"
            type="number"
            step="0.1"
            min="0.1"
            value={member.portion_factor}
            onChange={(event) => onChange({ portion_factor: Number(event.target.value) })}
            required
          />
        </label>
      </div>

      <fieldset className="member-constraints">
        <legend>Kostpreferenser</legend>
        <div className="chip-row">
          {DIETARY_FLAGS.map((flag) => (
            <Chip
              key={flag}
              pressed={member.dietary_flags.includes(flag)}
              onClick={() =>
                onChange({ dietary_flags: toggleValue(member.dietary_flags, flag) })
              }
            >
              {DIETARY_FLAG_LABELS[flag]}
            </Chip>
          ))}
        </div>
      </fieldset>

      <fieldset className="member-constraints allergy-group">
        {/* The warning glyph and the word "Allergier" carry the distinction on their
            own, so the red treatment is reinforcement rather than the only signal —
            this group must stay tellable from the preferences above it without
            relying on colour. */}
        <legend>
          <span aria-hidden="true">⚠ </span>Allergier
        </legend>
        <div className="chip-row">
          {ALLERGIES.map((allergy) => (
            <Chip
              key={allergy}
              variant="danger"
              pressed={member.allergies.includes(allergy)}
              onClick={() => onChange({ allergies: toggleValue(member.allergies, allergy) })}
            >
              {ALLERGY_LABELS[allergy]}
            </Chip>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

function OnboardingForm({
  session,
  onCreated,
}: {
  session: Session;
  onCreated: () => void;
}) {
  const [members, setMembers] = useState<HouseholdMember[]>([emptyMember("adult")]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Derived, never stored alongside the members: the numbering depends on the whole
  // roster, so a per-member copy would go stale the moment a member is added, removed
  // or switched between adult and child.
  const labels = memberLabels(members);
  // What each member would be called with the name cleared. Derived through the same
  // function rather than a parallel rule, so the hint can never promise a label the
  // form would not actually render.
  const fallbackLabels = memberLabels(members.map((member) => ({ ...member, name: undefined })));

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
    // A blank name is normalised away rather than sent as "": the schema treats
    // absent and empty identically, and the label fallback depends on it.
    const household: Household = {
      members: members.map(({ name, ...member }) => ({
        ...member,
        ...(name?.trim() ? { name: name.trim() } : {}),
      })),
    };
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
    <Card>
      <form onSubmit={handleSubmit}>
        <h2>Skapa hushåll</h2>
        <fieldset>
          <legend>Medlemmar</legend>
          {/* Allergies and preferences are set per person (#115): a household does
              not have allergies, people do, and knowing whose is what lets a meal be
              matched to whoever is actually eating it. */}
          <p className="field-hint">
            Ange allergier och kostpreferenser för varje person i hushållet.
          </p>
          {members.map((member, index) => (
            <MemberFields
              key={index}
              member={member}
              label={labels[index]!}
              fallbackLabel={fallbackLabels[index]!}
              index={index}
              onChange={(patch) => updateMember(index, patch)}
              onRemove={() => removeMember(index)}
              removable={members.length > 1}
            />
          ))}
          <Button type="button" variant="secondary" onClick={addMember}>
            Lägg till medlem
          </Button>
        </fieldset>

        <Button type="submit" variant="primary" disabled={busy}>
          Spara hushåll
        </Button>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
      </form>
    </Card>
  );
}

// The visible level of a "Billigare"/"Snabbare" chip. Same dot idiom as the cost
// tier meter above, and purely visual for the same reason — AdjustmentChips wires
// the level into the chip's accessible name so it is never conveyed by fill alone.
function levelMeter(level: number): string {
  return "●".repeat(level) + "○".repeat(MAX_WEIGHT_LEVEL - level);
}

function LevelChip({
  label,
  level,
  onTap,
  disabled,
}: {
  label: string;
  level: number;
  onTap: () => void;
  disabled: boolean;
}) {
  const atMax = level >= MAX_WEIGHT_LEVEL;
  return (
    <Chip
      pressed={level > 0}
      aria-label={`${label}, nivå ${level} av ${MAX_WEIGHT_LEVEL}${atMax ? ", högsta nivån" : ""}`}
      onClick={onTap}
      disabled={disabled}
    >
      {label} <span aria-hidden="true">{levelMeter(level)}</span>
    </Chip>
  );
}

/**
 * The refinement row (UX_FLOW §4/§5 step 5). Every chip produces a new suggestion
 * immediately — that is the whole reason these are chips and not slider notches
 * (DECISION_LOG 2026-07-31, and the 2026-08-05 chip entry). "Billigare" and "Snabbare" stay pressed
 * and keep showing their level for the rest of the session, so a household several
 * rerolls deep can still see what it asked for; the other three are momentary
 * actions and carry no pressed state.
 */
function AdjustmentChips({
  refinement,
  busy,
  onIncrement,
  onOtherCuisine,
  onSomethingElse,
  onReset,
}: {
  refinement: RefinementState;
  busy: boolean;
  onIncrement: (axis: WeightAxis) => void;
  onOtherCuisine: () => void;
  onSomethingElse: () => void;
  onReset: () => void;
}) {
  return (
    <div role="group" aria-label="Justera förslaget" className="chip-row tonight-group__chips">
      <LevelChip
        label="Billigare"
        level={weightLevel(refinement, "cost")}
        onTap={() => onIncrement("cost")}
        disabled={busy}
      />
      <LevelChip
        label="Snabbare"
        level={weightLevel(refinement, "time")}
        onTap={() => onIncrement("time")}
        disabled={busy}
      />
      <Chip onClick={onOtherCuisine} disabled={busy}>
        Annat kök
      </Chip>
      <Chip onClick={onSomethingElse} disabled={busy}>
        Något annat
      </Chip>
      <Chip onClick={onReset} disabled={busy}>
        Återställ
      </Chip>
    </div>
  );
}

/**
 * The Tonight card (UX_FLOW §4). Two actions: accept (→ shopping list) and "Lagad
 * ikväll", which records the dish as cooked so it stops being suggested for a while
 * (#88, UX_FLOW §5 step 8).
 *
 * "Lagad ikväll" is one tap with a visible, persistent confirmation and no new screen:
 * once marked it becomes a disabled button plus a `role="status"` line, so the state is
 * announced rather than conveyed by styling alone. `cooked` comes from the server on
 * load, so a reload lands on the confirmed state instead of offering the tap again.
 */
function SuggestionCard({
  result,
  cooked,
  marking,
  error,
  onAccept,
  onMarkCooked,
}: {
  result: TonightResult;
  cooked: boolean;
  marking: boolean;
  error: string | null;
  onAccept: () => void;
  onMarkCooked: () => void;
}) {
  return (
    <Card className="suggestion-card">
      <h3 className="suggestion-card__name">{result.template.name}</h3>
      <p className="suggestion-card__meta">
        <span role="img" aria-label={costTierLabel(result.template.cost_tier)}>
          <span aria-hidden="true">{costTierMeter(result.template.cost_tier)}</span>
        </span>{" "}
        · {PREP_TIME_LABELS[result.template.prep_time_band]}
      </p>
      <ul className="suggestion-card__ingredients">
        {result.ingredients.map((ingredient, index) => (
          <li key={index}>
            {INGREDIENT_ROLE_LABELS[ingredient.role]}: {ingredient.name}
            {ingredient.substituted ? " (ersättning)" : ""}
          </li>
        ))}
      </ul>
      <div className="suggestion-card__actions">
        <Button type="button" variant="primary" onClick={onAccept}>
          Acceptera
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="suggestion-card__cooked"
          onClick={onMarkCooked}
          disabled={cooked || marking}
        >
          Lagad ikväll
        </Button>
      </div>
      {cooked && (
        <p role="status" className="status-line">
          Lagad ✓
        </p>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </Card>
  );
}

/**
 * Stands in for the Tonight card while the first fetch is in flight, sized to
 * roughly the same footprint as the real card so nothing jumps once it resolves
 * (requirement 5 — no spinner on a blank screen). Purely decorative, so it's
 * hidden from assistive tech; the loading state is still announced via text.
 */
function SuggestionCardSkeleton() {
  return (
    <Card className="suggestion-card skeleton-card" aria-hidden="true">
      <div className="skeleton-line skeleton-line--title" />
      <div className="skeleton-line skeleton-line--meta" />
      <div className="skeleton-card__rows">
        <div className="skeleton-line skeleton-line--row" />
        <div className="skeleton-line skeleton-line--row" />
      </div>
      <div className="skeleton-line skeleton-line--button" />
    </Card>
  );
}

type TonightViewState = { status: "suggestion" } | { status: "shopping" };

function TonightView({
  data,
  accessToken,
  onGuided,
}: {
  data: TonightResponse;
  accessToken: string;
  onGuided: () => void;
}) {
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

  // Refinement state — React state only, per CLAUDE.md's session-scoped rule for
  // ephemeral input: nothing here touches localStorage, the URL or the household
  // profile, so a reload starts fresh (a fresh `data` prop from a remounted
  // TonightView, too). The mirroring ref exists because a single chip handler
  // applies two actions in a row and then reads the result — `refinementReducer` is
  // pure, so applying it against the ref keeps those steps consistent inside one
  // async handler instead of racing a batched state update.
  const [current, setCurrent] = useState<TonightResponse>(data);
  const [refinement, setRefinement] = useState<RefinementState>(() =>
    initialResult
      ? { ...INITIAL_REFINEMENT, excludedTemplateIds: [initialResult.template.id] }
      : INITIAL_REFINEMENT,
  );
  const refinementRef = useRef(refinement);
  const [fetchingNext, setFetchingNext] = useState(false);
  const [nextError, setNextError] = useState<string | null>(null);
  const acceptedRef = useRef(false);

  // Which dish is confirmed cooked, by template id rather than a bare boolean: the card
  // can change under a chip tap, and a flag would carry the previous dish's confirmation
  // over to a new suggestion. Seeded from the server so a reload keeps the confirmation.
  const [cookedTemplateId, setCookedTemplateId] = useState<string | null>(
    initialResult?.cookedToday ? initialResult.template.id : null,
  );
  const [markingCooked, setMarkingCooked] = useState(false);
  const [cookedError, setCookedError] = useState<string | null>(null);

  function apply(action: RefinementAction): RefinementState {
    const next = refinementReducer(refinementRef.current, action);
    refinementRef.current = next;
    setRefinement(next);
    return next;
  }

  // A session that showed suggestions and never got an acceptance is the case
  // Phase 2 needs counted — with the depth it reached, which is what separates
  // "walked away immediately" from "tried five times and gave up". `pagehide` is
  // the one lifecycle event that fires reliably on mobile, including a swipe-away.
  useEffect(() => {
    function reportAbandonedSession() {
      if (acceptedRef.current) return;
      if (refinementRef.current.excludedTemplateIds.length === 0) return;
      track({
        name: "refinement_session_abandoned",
        rerollDepth: refinementRef.current.rerollDepth,
      });
    }

    window.addEventListener("pagehide", reportAbandonedSession);
    return () => window.removeEventListener("pagehide", reportAbandonedSession);
  }, []);

  function showResponse(response: TonightResponse) {
    setCurrent(response);
    // The new dish carries its own cooked state from the server, so this both clears a
    // previous dish's confirmation and keeps one that is genuinely still true.
    setCookedTemplateId(response.result?.cookedToday ? response.result.template.id : null);
    setCookedError(null);
    if (response.result) apply({ type: "suggestion_shown", templateId: response.result.template.id });
  }

  async function handleMarkCooked() {
    const shown = current.result;
    if (!shown) return;

    setMarkingCooked(true);
    setCookedError(null);
    try {
      await markCooked(accessToken, shown.template.id, shown.substitutions);
      setCookedTemplateId(shown.template.id);
      track({
        name: "meal_cooked",
        templateId: shown.template.id,
        rerollDepth: refinementRef.current.rerollDepth,
      });
    } catch (err) {
      setCookedError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setMarkingCooked(false);
    }
  }

  function reportChipTap(chip: ChipId, next: RefinementState, level?: number) {
    track({
      name: "refinement_chip_tap",
      chip,
      weights: next.weights,
      level,
      rerollDepth: next.rerollDepth,
    });
  }

  /** The one request shape every chip but "Annat kök" makes. */
  function requestSuggestion(next: RefinementState, previous: string | undefined) {
    return runRefinement(async () => {
      showResponse(
        await fetchTonight(accessToken, {
          exclude: next.excludedTemplateIds,
          previous,
          weights: next.weights,
        }),
      );
    });
  }

  async function runRefinement(request: () => Promise<void>) {
    setFetchingNext(true);
    setNextError(null);
    try {
      await request();
    } catch (err) {
      setNextError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setFetchingNext(false);
    }
  }

  function handleIncrement(axis: WeightAxis) {
    const next = apply({ type: "increment", axis });
    const chip: ChipId = axis === "cost" ? "cheaper" : "faster";

    reportChipTap(chip, next, weightLevel(next, axis));
    void requestSuggestion(next, current.result?.template.id);
  }

  function handleSomethingElse() {
    const next = apply({ type: "reroll", chip: "something_else" });
    reportChipTap("something_else", next);

    void requestSuggestion(next, current.result?.template.id);
  }

  function handleOtherCuisine() {
    const shown = current.result;
    if (!shown) return;

    const next = apply({ type: "reroll", chip: "other_cuisine" });
    reportChipTap("other_cuisine", next);

    void runRefinement(async () => {
      const outcome = await searchOtherCuisine(
        (exclude, previous) =>
          fetchTonight(accessToken, { exclude, previous, weights: next.weights }),
        next,
        shown.template.id,
        shown.template.cuisine,
      );
      apply({ type: "exclude_templates", templateIds: outcome.excludedTemplateIds });
      showResponse(outcome.response);
    });
  }

  function handleReset() {
    const next = apply({ type: "reset" });
    reportChipTap("reset", next);

    // No `previous` either: a reset is a fresh start, not another step away from
    // the dish that happened to be on screen.
    void requestSuggestion(next, undefined);
  }

  const result = current.result;

  return (
    <div>
      <h2 className="tonight-kicker">Ikväll</h2>
      {nextError && (
        <p role="alert" className="error-text">
          {nextError}
        </p>
      )}
      {result === null && current.reason === "no_more_suggestions" && (
        // Recoverable, never a dead end (UX_FLOW §9): the household has safe
        // options left, it has just excluded all of them this session, so the way
        // out is the same "Återställ" the chip row offers.
        <Card className="state-card">
          <p>Du har sett allt vi har för ikväll</p>
          <Button type="button" variant="primary" onClick={handleReset} disabled={fetchingNext}>
            Återställ
          </Button>
        </Card>
      )}
      {result === null && current.reason !== "no_more_suggestions" && (
        <Card className="state-card">
          <pre className="error-text">{`no result: ${current.reason}`}</pre>
        </Card>
      )}
      {result !== null && state.status === "suggestion" && (
        <>
          <div className="tonight-group">
            <SuggestionCard
              result={result}
              cooked={cookedTemplateId === result.template.id}
              marking={markingCooked}
              error={cookedError}
              onAccept={() => {
                acceptedRef.current = true;
                setState({ status: "shopping" });
              }}
              onMarkCooked={() => void handleMarkCooked()}
            />
            <AdjustmentChips
              refinement={refinement}
              busy={fetchingNext}
              onIncrement={handleIncrement}
              onOtherCuisine={handleOtherCuisine}
              onSomethingElse={handleSomethingElse}
              onReset={handleReset}
            />
          </div>
          {fetchingNext && <p className="muted tonight-fetching">Hämtar…</p>}
        </>
      )}
      {state.status === "suggestion" && (
        // The way into the guided quick-select flow (UX_FLOW §5): the path for a
        // household that wants control without typing. Deliberately secondary to the
        // card above — Tonight is the zero-input default, and §4 is explicit that
        // this must not become a menu of options in front of it.
        <Button type="button" variant="secondary" className="guided-entry" onClick={onGuided}>
          Välj själv
        </Button>
      )}
      {result !== null && state.status === "shopping" && (
        <ShoppingList
          result={result}
          portions={current.portions}
          accessToken={accessToken}
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
  // fetchTonight never reached the server at all — a network failure, not an
  // application error. UX_FLOW §7's offline requirement: the shell must still
  // open and show whatever shopping list is already on the device, never a
  // blank screen or a raw error.
  | { status: "offline"; list: ReturnType<typeof loadAnyShoppingList> }
  | { status: "error"; code: string; message: string };

function toGateState(error: unknown): GateState {
  if (error instanceof ApiError) {
    if (error.code === "household_not_found") return { status: "no_household" };
    return { status: "error", code: error.code, message: error.message };
  }
  return { status: "offline", list: loadAnyShoppingList() };
}

function Gate({ session }: { session: Session }) {
  const [state, setState] = useState<GateState>({ status: "checking" });
  // Which of the two paths is on screen. Session state only: the app opens on the
  // zero-input Tonight card (UX_FLOW §4), never on the flow the household happened
  // to leave open — with one exception, resolved once the Tonight response arrives.
  const [view, setView] = useState<"tonight" | "guided">("tonight");
  // A shopping list on the device that is not the Tonight suggestion's belongs to a
  // dish chosen in the guided flow. Reloading in the shop must land back on it
  // (UX_FLOW §7), which TonightView cannot do — it only restores a list matching the
  // dish it is showing.
  const [resumed, setResumed] = useState<StoredShoppingList | undefined>(undefined);

  // Installs the real transport (issue #91) — analytics.ts's default sink just logs
  // in dev otherwise. Owned by Gate rather than by TonightView because switching to
  // the guided flow unmounts TonightView, and `handle.stop()` deliberately does not
  // flush: an owner that comes and goes with the view would drop up to one flush
  // interval of buffered events every time the household taps "Välj själv".
  //
  // Registered before TonightView mounts, so TonightView's own pagehide listener
  // (the abandoned-session event) registers second and therefore *runs* second —
  // that event must reach the buffer before this handle flushes it, and pagehide
  // listeners fire in registration order.
  useEffect(() => {
    const handle = createHttpAnalyticsSink(session.access_token);
    setAnalyticsSink(handle.sink);
    return () => {
      handle.stop();
      setAnalyticsSink(null);
    };
  }, [session.access_token]);
  // Bumped by the offline screen's "Försök igen" button to re-run the fetch
  // below without duplicating its request/cancellation logic in a second effect.
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "checking" });

    fetchTonight(session.access_token)
      .then((data) => {
        if (cancelled) return;
        const stored = loadAnyShoppingList();
        if (stored && stored.templateId !== data.result?.template.id) {
          setResumed(stored);
          setView("guided");
        }
        setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState(toGateState(error));
      });

    return () => {
      cancelled = true;
    };
  }, [session.access_token, retryCount]);

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
      <div className="list-row">
        <span className="muted">Signed in as {session.user.email}</span>
        <Button type="button" variant="secondary" onClick={() => supabase.auth.signOut()}>
          Sign out
        </Button>
      </div>
      {state.status === "checking" && (
        <>
          <p className="muted sr-only">Loading…</p>
          <SuggestionCardSkeleton />
        </>
      )}
      {state.status === "error" && (
        <Card className="state-card">
          <pre className="error-text">{`error: ${state.code}\n${state.message}`}</pre>
        </Card>
      )}
      {state.status === "offline" && state.list && <OfflineShoppingList list={state.list} />}
      {state.status === "offline" && !state.list && (
        <Card className="state-card">
          <p role="status">Ingen anslutning. Anslut till internet för att komma igång.</p>
          <Button type="button" variant="primary" onClick={() => setRetryCount((n) => n + 1)}>
            Försök igen
          </Button>
        </Card>
      )}
      {state.status === "no_household" && (
        <OnboardingForm session={session} onCreated={handleCreated} />
      )}
      {state.status === "ready" && view === "tonight" && (
        <TonightView
          data={state.data}
          accessToken={session.access_token}
          onGuided={() => setView("guided")}
        />
      )}
      {state.status === "ready" && view === "guided" && (
        <GuidedFlow
          accessToken={session.access_token}
          resume={resumed}
          onExit={() => {
            setResumed(undefined);
            setView("tonight");
          }}
        />
      )}
    </div>
  );
}

// Chrome's install-prompt event — not part of lib.dom.d.ts because it is a
// nonstandard (Chromium-only) extension, never fired by Firefox or Safari.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

/**
 * The install affordance shows up only if the browser itself decided the app
 * is installable and fired `beforeinstallprompt` — never a custom banner, nag,
 * or iOS-specific instructions (issue #93). Most browsers (Firefox, Safari)
 * never fire this event at all, so `canInstall` simply stays false there and
 * nothing renders.
 */
function useInstallPrompt() {
  const [deferredEvent, setDeferredEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    function handleBeforeInstallPrompt(event: Event) {
      event.preventDefault();
      setDeferredEvent(event as BeforeInstallPromptEvent);
    }
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  }, []);

  async function install() {
    if (!deferredEvent) return;
    await deferredEvent.prompt();
    // The captured event is single-use regardless of the user's choice — the
    // browser will fire a fresh `beforeinstallprompt` later if it decides to
    // offer installation again.
    setDeferredEvent(null);
  }

  return { canInstall: deferredEvent !== null, install };
}

function InstallButton() {
  const { canInstall, install } = useInstallPrompt();
  if (!canInstall) return null;

  return (
    <Button type="button" variant="secondary" onClick={() => void install()}>
      Installera appen
    </Button>
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
  return (
    <>
      <InstallButton />
      {session === null ? <LoginForm /> : <Gate session={session} />}
    </>
  );
}
