import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { BrowserRouter, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabaseClient";
import {
  ApiError,
  createHousehold,
  fetchHousehold,
  fetchTonight,
  markCooked,
  updateHousehold,
  updatePreferenceWeights,
  NEUTRAL_PREFERENCE_WEIGHTS,
  type DinerLabel,
  type IngredientOption,
  type PreferenceWeights,
  type TonightResponse,
  type TonightResult,
} from "./api";
import { DIETARY_FLAGS, type DietaryFlag } from "../../src/schema/vocabulary";
import {
  MEMBER_NAME_MAX_LENGTH,
  memberLabels,
  type Household,
  type HouseholdMember,
  type HouseholdMemberType,
} from "../../src/schema/household";
import {
  costTierLabel,
  dinerChangeReasonLine,
  EFFORT_LEVEL_LABELS,
  PREP_TIME_LABELS,
  suggestionReasonLine,
} from "./display";
import { DinerPicker, useDinerSelection } from "./DinerPicker";
import { GuidedFlow } from "./GuidedFlow";
import { OfflineShoppingList, ShoppingList, type ShoppingListMeal } from "./ShoppingList";
import { loadAnyShoppingList, type StoredShoppingList } from "./shoppingListStorage";
import { CookScreen, CookScreenEmpty, type CookMeal } from "./CookScreen";
import { loadLatestCookRecord, substitutionKey } from "./instructionsStorage";
import { authErrorMessage, GENERIC_AUTH_ERROR } from "./authErrors";
import { setAnalyticsSink, track } from "./analytics";
import { createHttpAnalyticsSink } from "./analyticsSink";
import { Button } from "./components/Button";
import { Card } from "./components/Card";
import { Chip } from "./components/Chip";
import { PreferenceBlock } from "./components/PreferenceBlock";
import { RefreshIcon } from "./components/RefreshIcon";
import { Screen } from "./components/Screen";
import { StateScreen } from "./components/StateScreen";
import { presentError, GENERIC_ERROR_MESSAGE, OFFLINE_MESSAGE } from "./errorPresentation";
import {
  INITIAL_REFINEMENT,
  isAxisActive,
  refinementReducer,
  searchOtherCuisine,
  type ChipId,
  type RefinementAction,
  type RefinementState,
  type WeightAxis,
} from "./refinement";

// One screen, four states: signed out (login form), household unknown (loading),
// no household (onboarding), household exists (Tonight view). This slice is a
// wire, not a screen — no router, no component library, no styling beyond browser
// defaults.

export const DIETARY_FLAG_LABELS: Record<DietaryFlag, string> = {
  vegetarian: "Vegetariskt",
  vegan: "Veganskt",
  high_protein_preference: "Proteinrikt",
};

// Re-exported so existing consumers (and tests) keep importing these from App,
// while the guided flow can import them without the two modules importing each
// other. The definitions live in display.ts.
export { costTierLabel, PREP_TIME_LABELS };

type AuthMode = "sign_in" | "sign_up";

/**
 * The first screen anyone sees (#168). It leads with what the product does, not
 * with its own name, and carries **one** primary action: the old two-equal-buttons
 * layout made the household decide whether they were new before they were allowed
 * to do anything, which is the wrong decision to put first. Signing in is the
 * default mode; "Skapa konto" is a quiet text link that switches the mode and the
 * button's label, not a second button competing with it.
 */
function LoginForm() {
  const [mode, setMode] = useState<AuthMode>("sign_in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function switchMode() {
    setMode((current) => (current === "sign_in" ? "sign_up" : "sign_in"));
    // Both belong to the mode that produced them — a "wrong password" line left
    // hanging over a freshly-switched sign-up form describes nothing on screen.
    setError(null);
    setNotice(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      if (mode === "sign_in") {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) setError(authErrorMessage(signInError));
      } else {
        const { data, error: signUpError } = await supabase.auth.signUp({ email, password });
        if (signUpError) {
          setError(authErrorMessage(signUpError));
        } else if (!data.session) {
          // Sign-up succeeded but the project requires email confirmation, so no
          // session arrives and `onAuthStateChange` never fires: without this line
          // the primary action would visibly do nothing at all. Not a verification
          // flow — just the acknowledgement that unhandled state was missing.
          setNotice("Kontot är skapat. Bekräfta din e-postadress så kan du logga in.");
        }
      }
    } catch {
      // supabase-js rethrows anything that isn't an AuthError — a failed session
      // write in private browsing, for one. Without this the form would stay busy
      // forever with nothing on screen, which is the same "the primary action did
      // nothing" failure the notice above exists to close.
      setError(GENERIC_AUTH_ERROR);
    } finally {
      setBusy(false);
    }
  }

  const submitLabel = mode === "sign_in" ? "Logga in" : "Skapa konto";
  const switchLabel =
    mode === "sign_in" ? "Ny här? Skapa konto" : "Har du redan ett konto? Logga in";

  return (
    <Card className="auth-card">
      <form onSubmit={(event) => void handleSubmit(event)}>
        <h1 className="auth-title">Vad ska ni äta ikväll?</h1>
        <p className="auth-lede">
          Matmatch föreslår kvällens middag utifrån vilka ni är i hushållet — utan att du
          behöver leta recept.
        </p>
        <div className="field">
          <label htmlFor="auth-email">E-post</label>
          <input
            id="auth-email"
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="auth-password">Lösenord</label>
          <input
            id="auth-password"
            className="input"
            type="password"
            autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={6}
          />
        </div>
        <Button type="submit" variant="primary" className="auth-submit" disabled={busy}>
          {submitLabel}
        </Button>
        <button type="button" className="auth-switch" onClick={switchMode} disabled={busy}>
          {switchLabel}
        </button>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="auth-notice">
            {notice}
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
    dietary_flags: [],
  };
}

// Turns edited form members into what the API accepts, shared by onboarding (#115)
// and the profile screen (#166) so there is exactly one place that decides a blank
// name is normalised away rather than sent as "".
function toHouseholdPayload(members: readonly HouseholdMember[]): Household {
  return {
    members: members.map(({ name, ...member }) => ({
      ...member,
      ...(name?.trim() ? { name: name.trim() } : {}),
    })),
  };
}

const TYPE_LABELS: Record<HouseholdMemberType, string> = {
  adult: "Vuxen",
  child: "Barn",
};

/**
 * Who a member is — name, type, portion size. Nothing here is a constraint on what
 * they can eat: onboarding (#168) asks for exactly this and nothing else, and the
 * profile screen wraps the same row in its preference and allergy groups below.
 */
function MemberBasicFields({
  member,
  fallbackLabel,
  idPrefix,
  onChange,
}: {
  member: HouseholdMember;
  /** What blank would produce. Distinct from the member's current label: for a
   *  named member the hint still has to say what clearing the field gets you, not
   *  repeat their name back. */
  fallbackLabel: string;
  idPrefix: string;
  onChange: (patch: Partial<HouseholdMember>) => void;
}) {
  const nameId = `${idPrefix}-name`;
  const nameHintId = `${idPrefix}-name-hint`;

  return (
    <>
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
    </>
  );
}

/**
 * One member's editable fields on the profile screen (#166) — who they are, plus
 * both constraint groups. Onboarding deliberately does not use this: it asks who
 * lives here and one allergy question, and nothing else (#168).
 */
function MemberDetailFields({
  member,
  fallbackLabel,
  idPrefix,
  onChange,
}: {
  member: HouseholdMember;
  fallbackLabel: string;
  idPrefix: string;
  onChange: (patch: Partial<HouseholdMember>) => void;
}) {
  return (
    <>
      <MemberBasicFields
        member={member}
        fallbackLabel={fallbackLabel}
        idPrefix={idPrefix}
        onChange={onChange}
      />

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
    </>
  );
}

/** Onboarding's member block (#168) — name, type and portion size, always open.
 *  Dietary preferences are not here at all: they are ranking influence, not safety,
 *  and belong on the profile where they can be adjusted once the household has seen
 *  what the app suggests. Allergies live behind the question below the list. */
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
  fallbackLabel: string;
  index: number;
  onChange: (patch: Partial<HouseholdMember>) => void;
  onRemove: () => void;
  removable: boolean;
}) {
  return (
    <div className="member-card">
      <div className="member-card-header">
        <h3 className="member-card-title">{label}</h3>
        <Button type="button" variant="destructive" onClick={onRemove} disabled={!removable}>
          Ta bort
        </Button>
      </div>
      <MemberBasicFields
        member={member}
        fallbackLabel={fallbackLabel}
        idPrefix={`member-${index}`}
        onChange={onChange}
      />
    </div>
  );
}

/**
 * Onboarding's one question, and the reason this screen was rebuilt (#168,
 * DECISION_LOG 2026-08-16). Neither option is preselected and the primary action
 * stays disabled until one is picked: a checked "Nej" would make a household that
 * answered no indistinguishable from one that never saw the question, and the app
 * would treat both as allergy-free — assuming a safety answer nobody gave.
 *
 * A radio group rather than chips, because these are two mutually exclusive answers
 * to one question and must be announced as such.
 */
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
    try {
      await createHousehold(session.access_token, toHouseholdPayload(members));
      onCreated();
    } catch (err) {
      const presented = presentError(err, "onboarding");
      setError(presented.kind === "offline" ? OFFLINE_MESSAGE : GENERIC_ERROR_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="onboarding-card">
      <form onSubmit={(event) => void handleSubmit(event)}>
        <h2 className="onboarding-title">Vilka bor här?</h2>
        <p className="onboarding-lede">
          Portionerna och förslagen utgår från hushållet. Du kan ändra allt senare.
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
        <button type="button" className="member-add-row" onClick={addMember}>
          + Lägg till medlem
        </button>

        <Button
          type="submit"
          variant="primary"
          className="onboarding-submit"
          disabled={busy}
        >
          Visa kvällens middag
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

const WEEKDAYS = ["Söndag", "Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag", "Lördag"];

// The Tonight eyebrow's weekday (#138) — read from the local clock, since the
// server response carries no day of its own to trust or mistrust.
export interface PreferenceBaseline {
  /**
   * The value once a drag (or a keyboard step) commits — never a live, per-notch
   * value. Persisting and re-ranking key off this, so neither happens mid-drag.
   *
   * Deliberately not "what the sliders render": that used to live here too, which
   * meant every notch of a drag called `setState` on `Gate` — the component owning
   * the whole fetched Tonight response and routed shell — and re-rendered the
   * entire screen under the sliders (suggestion card, chips, pantry row) for a
   * value nothing outside `PreferenceBlock` reads live. `PreferenceBlock` now owns
   * that per-notch state itself, so a drag re-renders only the small subtree
   * showing it (2026-08-23, the actual cause of "the slider isn't smooth" once the
   * settle-timer and touch-action fixes still weren't enough).
   */
  settled: PreferenceWeights;
  onCommit: (weights: PreferenceWeights) => void;
  /** Until the first load lands there is nothing honest to show — the block waits. */
  ready: boolean;
}

/**
 * The household's persistent preference baseline (#157/#159), owned once at the top so
 * Tonight's collapsed block and the profile's section are two views of one value rather
 * than two copies that drift.
 *
 * Written through `PUT /api/households/preferences`, never through the profile PUT —
 * that route is a full replacement with no version check, so a member edit would
 * silently zero whatever the sliders had set (DECISION_LOG 2026-08-16).
 *
 * A failed write is deliberately not surfaced. The household is dragging a preference,
 * not saving a form; an error banner over the suggestion for a control whose entire
 * feedback is the dish changing underneath it would be louder than what it reports, and
 * the next drag retries anyway.
 */
function usePreferenceBaseline(
  accessToken: string,
  /**
   * The stored baseline as it arrived on the Tonight response. `undefined` until the
   * first response lands — and once seeded, later values are ignored: the household may
   * have dragged a slider since, and a background refetch carrying the pre-drag value
   * must not yank the control back under their thumb.
   */
  stored: PreferenceWeights | undefined,
): PreferenceBaseline {
  const [settled, setSettled] = useState<PreferenceWeights | null>(null);

  useEffect(() => {
    if (stored === undefined) return;
    setSettled((current) => current ?? stored);
  }, [stored]);

  // Fired from the slider's native `change` event (release for a pointer drag, once
  // per press for the keyboard) rather than a settle timer — see PreferenceSlider's
  // own comment. A write and a re-rank can never be triggered mid-drag this way, so
  // there is nothing to debounce.
  function onCommit(next: PreferenceWeights) {
    setSettled(next);
    void updatePreferenceWeights(accessToken, next).catch(() => {});
  }

  return {
    settled: settled ?? NEUTRAL_PREFERENCE_WEIGHTS,
    onCommit,
    ready: settled !== null,
  };
}

/**
 * Tonight's "Vad har du hemma?" row (#152).
 *
 * A few likely staples, not the catalog: this is the zero-input screen, and a full
 * picker here would be a screen-sized interruption on the one surface that exists to
 * avoid input. The visible set is the head of the same frequency-ordered list the
 * guided flow's step-3 grid is built from, plus anything already selected — a chip the
 * household turned on must never disappear because a diner change reshuffled the list
 * under it — and then "Fler", which opens the full grid in a layer.
 */
const PANTRY_ROW_SIZE = 6;

function visiblePantryOptions(
  options: readonly IngredientOption[],
  selected: readonly string[],
): IngredientOption[] {
  const head = options.slice(0, PANTRY_ROW_SIZE);
  const shown = new Set(head.map((option) => option.id));
  const alsoSelected = options.filter(
    (option) => selected.includes(option.id) && !shown.has(option.id),
  );
  return [...head, ...alsoSelected];
}

function PantryRow({
  options,
  selected,
  busy,
  onToggle,
  onOpenAll,
}: {
  options: readonly IngredientOption[];
  selected: readonly string[];
  busy: boolean;
  onToggle: (ingredientId: string) => void;
  onOpenAll: () => void;
}) {
  if (options.length === 0) return null;
  const visible = visiblePantryOptions(options, selected);

  return (
    <section className="tonight-pantry">
      <p className="text-eyebrow">Vad har du hemma?</p>
      <div role="group" aria-label="Varor hemma" className="chip-row">
        {visible.map((option) => (
          <Chip
            key={option.id}
            pressed={selected.includes(option.id)}
            disabled={busy}
            onClick={() => onToggle(option.id)}
          >
            {option.name}
          </Chip>
        ))}
        {options.length > visible.length && (
          <Chip disabled={busy} onClick={onOpenAll}>
            Fler
          </Chip>
        )}
      </div>
    </section>
  );
}

/**
 * The full pantry grid, in a layer over Tonight rather than a route (#152).
 *
 * The guided flow's own grid, unchanged — same options, same multi-select, same chip
 * behaviour — because "what do you have at home" must not be two different questions
 * depending on which screen asked it. A layer rather than navigation so the suggestion
 * is still there when it closes: leaving the screen to answer a side question is how a
 * zero-input surface turns into a form.
 */
function PantrySheet({
  options,
  selected,
  onToggle,
  onClose,
}: {
  options: readonly IngredientOption[];
  selected: readonly string[];
  onToggle: (ingredientId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="pantry-sheet" role="dialog" aria-modal="true" aria-label="Vad har du hemma?">
      <div className="pantry-sheet__panel">
        <div className="pantry-sheet__head">
          <h2 className="pantry-sheet__title">Vad har du hemma?</h2>
          <Button type="button" variant="secondary" onClick={onClose}>
            Klar
          </Button>
        </div>
        <p className="muted pantry-sheet__hint">
          Valfritt — vi använder det bara för att välja förslag, och sparar det inte.
        </p>
        <div role="group" aria-label="Alla varor hemma" className="ingredient-grid">
          {options.map((option) => (
            <Chip
              key={option.id}
              className="ingredient-grid__item"
              pressed={selected.includes(option.id)}
              onClick={() => onToggle(option.id)}
            >
              {option.name}
            </Chip>
          ))}
        </div>
      </div>
    </div>
  );
}

function weekdayLabel(): string {
  return WEEKDAYS[new Date().getDay()]!;
}

// The Tonight eyebrow's household half (#138), built from the diner labels the
// response already carries (DinerLabel has no `type`, so this cannot reproduce
// Lovable's "2 vuxna + 1 barn" breakdown — it joins whatever labels the server sent).
function dinersLabel(diners: readonly DinerLabel[] | undefined): string {
  return (diners ?? []).map((diner) => diner.label).join(", ");
}

/**
 * Whether any adjustment chip is currently expressing something (#183).
 *
 * Only the toggle chips can be "on" — "Annat kök" and "Byt förslag" are momentary
 * actions that leave no state behind. This is what "Återställ" is offered against:
 * a permanent reset chip beside four chips that are all off is a control for
 * undoing nothing, taking a slot in the one row that is supposed to hold only
 * things that do something right now.
 */
function hasActiveAdjustment(refinement: RefinementState): boolean {
  return (["price", "time", "variation", "simplicity"] as const).some((axis) =>
    isAxisActive(refinement, axis),
  );
}

/**
 * A chip with a binary on/off state (2026-08-23, DECISION_LOG — supersedes the
 * 0/1/2 level cycle). `pressed` plus `aria-pressed` (from `Chip`) is the whole
 * affordance; there is no level to show, so no meter, dots or accessible-name
 * suffix. Same pressed/unpressed idiom as the pantry chips already on this
 * screen — one fewer idiom for a household to learn.
 */
function ToggleChip({
  label,
  active,
  onTap,
  disabled,
}: {
  label: string;
  active: boolean;
  onTap: () => void;
  disabled: boolean;
}) {
  return (
    <Chip pressed={active} onClick={onTap} disabled={disabled}>
      {label}
    </Chip>
  );
}

/**
 * The refinement row (UX_FLOW §4/§5 step 5). Every chip produces a new suggestion
 * immediately — that is the whole reason these are chips and not slider notches
 * (DECISION_LOG 2026-07-31, and the 2026-08-05 chip entry). "Billigare" and "Snabbare" stay pressed
 * for the rest of the session, so a household several rerolls deep can still see
 * what it asked for; the other two are momentary actions and carry no pressed
 * state. "Något annat" is not here — #142 moved that control onto the suggestion
 * itself as "Byt förslag", matching the reference exactly rather than duplicating
 * it in both places.
 */
function AdjustmentChips({
  refinement,
  busy,
  onToggle,
  onOtherCuisine,
  onReset,
}: {
  refinement: RefinementState;
  busy: boolean;
  onToggle: (axis: WeightAxis) => void;
  onOtherCuisine: () => void;
  onReset: () => void;
}) {
  return (
    <div role="group" aria-label="Justera förslaget" className="chip-row">
      <ToggleChip
        label="Billigare"
        active={isAxisActive(refinement, "price")}
        onTap={() => onToggle("price")}
        disabled={busy}
      />
      <ToggleChip
        label="Snabbare"
        active={isAxisActive(refinement, "time")}
        onTap={() => onToggle("time")}
        disabled={busy}
      />
      {/* #153: the variation axis, same mechanic as the two above — a session
          delta on the household's own Variation baseline, never a parallel
          weight. */}
      <ToggleChip
        label="Testa nytt"
        active={isAxisActive(refinement, "variation")}
        onTap={() => onToggle("variation")}
        disabled={busy}
      />
      {/* #153, gated on #151's curated effort_level: the simplicity axis, same
          mechanic as the three above — a session delta on the household's own
          Enkelhet baseline. */}
      <ToggleChip
        label="Enklare"
        active={isAxisActive(refinement, "simplicity")}
        onTap={() => onToggle("simplicity")}
        disabled={busy}
      />
      <Chip onClick={onOtherCuisine} disabled={busy}>
        Annat kök
      </Chip>
      {/* #183: only when something is actually on. See `hasActiveAdjustment`. */}
      {hasActiveAdjustment(refinement) && (
        <Chip onClick={onReset} disabled={busy}>
          Återställ
        </Chip>
      )}
    </div>
  );
}

/**
 * The Tonight suggestion (UX_FLOW §4). Rendered directly on the page background,
 * not in a `Card` — #142 removed the card chrome to match the reference exactly;
 * cards group lists and collapsible blocks, never a screen's own main content (see
 * `docs/UX_FLOW.md` §4). One action: "Laga ikväll", which both records the dish as
 * cooked (#88) and takes the household straight to the shopping list — there is no
 * separate accept step and no separate confirmation state (DECISION_LOG 2026-08-16).
 * "Byt förslag" takes over exactly what the "Något annat" chip used to do.
 *
 * No ingredient list (#183). Six rows of role-prefixed taxonomy between the blurb and
 * the chips answered a question nobody asks at this moment — what is *in* it matters
 * when you shop and when you cook, and both of those screens list it properly, with
 * amounts and allergen markings this one never had. What belongs here instead is the
 * one quiet line saying why this dish: "Valt för att ni har gul lök och potatis
 * hemma" buys more trust than an inventory, and it is what the reference shows.
 */
function SuggestionCard({
  result,
  swapBusy,
  onChoose,
  onSwap,
}: {
  result: TonightResult;
  swapBusy: boolean;
  onChoose: () => void;
  onSwap: () => void;
}) {
  const reasonLine = suggestionReasonLine(result.reasonCodes ?? [], result.pantryMatch ?? []);

  return (
    <div className="suggestion">
      <h3 className="suggestion__name">{result.template.name}</h3>
      <p className="suggestion__meta">
        {PREP_TIME_LABELS[result.template.prep_time_band]}
        {" · "}
        {costTierLabel(result.template.cost_tier)}
        {" · "}
        {EFFORT_LEVEL_LABELS[result.template.effort_level]}
      </p>
      <p className="suggestion__blurb">{result.template.blurb}</p>
      {reasonLine && <p className="suggestion__reason suggestion__reason--muted">{reasonLine}</p>}
      <div className="suggestion__actions">
        <Button type="button" variant="primary" className="suggestion__choose" onClick={onChoose}>
          Laga ikväll
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="suggestion__swap"
          onClick={onSwap}
          disabled={swapBusy}
        >
          <RefreshIcon />
          Byt förslag
        </Button>
      </div>
    </div>
  );
}

/**
 * Stands in for the Tonight suggestion while the first fetch is in flight, sized to
 * roughly the same footprint as the real content so nothing jumps once it resolves
 * (requirement 5 — no spinner on a blank screen). Purely decorative, so it's
 * hidden from assistive tech; the loading state is still announced via text.
 */
function SuggestionCardSkeleton() {
  return (
    <div className="suggestion skeleton-card" aria-hidden="true">
      <div className="skeleton-line skeleton-line--title" />
      <div className="skeleton-line skeleton-line--title-2" />
      <div className="skeleton-line skeleton-line--meta" />
      <div className="skeleton-line skeleton-line--reason" />
      <div className="skeleton-card__actions">
        <div className="skeleton-line skeleton-line--button" />
        <div className="skeleton-line skeleton-line--button-secondary" />
      </div>
    </div>
  );
}

/**
 * What replaces the suggestion card when Tonight has nothing to show (#170).
 * Three named reasons the server actually sends, or the client sets while a
 * background refetch is in flight, plus a defensive fallback for anything
 * else. Only the fallback ever logs a code — the three named branches are
 * expected, everyday states, not failures.
 */
function TonightEmptyState({
  reason,
  busy,
  onReset,
  onGoToProfile,
}: {
  reason: string;
  busy: boolean;
  onReset: () => void;
  onGoToProfile: () => void;
}) {
  if (reason === "household_updated") {
    // Transient: Gate's own background refetch after a profile save
    // (`handleHouseholdUpdated`) is already in flight — a loading beat, not a
    // state to explain, so it gets the same placeholder the initial load does.
    return <SuggestionCardSkeleton />;
  }

  if (reason === "no_safe_templates") {
    // Nothing is broken — the household's own allergies and diet leave no
    // safe dish tonight, which is the profile's problem to solve, not this
    // screen's (mirrors GuidedFlow's NoSafeTemplates).
    return (
      <StateScreen
        variant="dashed"
        role="status"
        title="Inget i kvällens meny passar hushållet"
        body="Se över allergier och kostval i hushållet, så öppnar fler rätter upp sig."
        action={{ label: "Till hushållet", onClick: onGoToProfile }}
      />
    );
  }

  if (reason === "no_more_suggestions") {
    // UX_FLOW §9: recoverable, never a dead end — the household has safe
    // options left, it has just excluded all of them this session, described
    // honestly as a catalog limit rather than a failure.
    return (
      <StateScreen
        variant="dashed"
        role="status"
        title="Du har sett kvällens hela urval"
        body="Med dagens val finns inget mer i katalogen ikväll. Återställ så börjar vi om."
        action={{ label: "Återställ", onClick: onReset, disabled: busy }}
      />
    );
  }

  return <TonightUnknownReasonState reason={reason} busy={busy} onRetry={onReset} />;
}

/** The one branch of `TonightEmptyState` that is an actual failure — a reason
 *  the server should never send. Logged in an effect, not inline, so a
 *  re-render of the same state never logs the same code twice. */
function TonightUnknownReasonState({
  reason,
  busy,
  onRetry,
}: {
  reason: string;
  busy: boolean;
  onRetry: () => void;
}) {
  useEffect(() => {
    track({ name: "app_error_shown", context: "tonight_no_result", code: reason });
  }, [reason]);

  return (
    <StateScreen
      variant="solid"
      role="alert"
      title="Kunde inte visa kvällens förslag"
      body={GENERIC_ERROR_MESSAGE}
      action={{ label: "Försök igen", onClick: onRetry, disabled: busy }}
      reference={reason}
    />
  );
}

function TonightView({
  data,
  accessToken,
  baseline,
}: {
  data: TonightResponse;
  accessToken: string;
  /** The shared household baseline (#159) — the same value the profile edits. */
  baseline: PreferenceBaseline;
}) {
  const navigate = useNavigate();
  const initialResult = data.result;

  // Refinement state — React state only, per CLAUDE.md's session-scoped rule for
  // ephemeral input: nothing here touches localStorage, the URL or the household
  // profile, so a reload starts fresh (a fresh `data` prop from a remounted
  // TonightView, too). The mirroring ref exists because a single chip handler
  // applies two actions in a row and then reads the result — `refinementReducer` is
  // pure, so applying it against the ref keeps those steps consistent inside one
  // async handler instead of racing a batched state update.
  const [current, setCurrent] = useState<TonightResponse>(data);
  // Who is eating, seeded to everyone from the labels the response carries. Session
  // state only, exactly like the refinement above it: no localStorage, no URL, and no
  // write back to the household — deselecting someone for one evening is not an edit
  // to who lives here. Reset to everyone whenever the roster changes (DinerPicker.tsx).
  const diners = useDinerSelection(current.diners);
  const [refinement, setRefinement] = useState<RefinementState>(() =>
    initialResult
      ? { ...INITIAL_REFINEMENT, excludedTemplateIds: [initialResult.template.id] }
      : INITIAL_REFINEMENT,
  );
  const refinementRef = useRef(refinement);
  const [fetchingNext, setFetchingNext] = useState(false);
  const [nextError, setNextError] = useState<string | null>(null);
  const acceptedRef = useRef(false);

  // #133: who the dish on screen was just replaced *for*, when the diner-change
  // effect below asked to keep it and could not. `null` whenever nothing was
  // replaced — including every non-diner-change request, so a chip tap always
  // clears a lingering notice from an earlier diner change rather than leaving it
  // stranded on a dish it no longer describes.
  const [dinerReplacedFor, setDinerReplacedFor] = useState<string | undefined>(undefined);
  // The "Fler" layer (#152). Plain view state — it holds no selection of its own, it
  // just shows the same list the row does at full length.
  const [pantrySheetOpen, setPantrySheetOpen] = useState(false);

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
    // `replacedFor` is only ever present on the diner-change "keep" request's
    // response (#133) — every other response omits it, which is what clears a
    // notice left over from an earlier diner change once the household does
    // anything else.
    setDinerReplacedFor(response.replacedFor);
    if (response.result) apply({ type: "suggestion_shown", templateId: response.result.template.id });
  }

  /**
   * "Laga ikväll" (#142, DECISION_LOG 2026-08-16): choosing the dish *is* the
   * accept action, merged with what used to be a separate "Lagad ikväll" tap. Fires
   * `meal_chosen` at the moment of choice, regardless of whether the history write
   * that follows succeeds — the household chose the dish either way, and Phase 2's
   * choice metric must count that, not the bookkeeping outcome. A failed write
   * cannot be acted on by the household, so it never reaches the UI: it is reported
   * as `meal_choice_history_failed` and navigation to the shopping list proceeds
   * regardless, exactly as it does on success.
   */
  async function handleChooseTonight() {
    const shown = current.result;
    if (!shown) return;

    acceptedRef.current = true;
    track({
      name: "meal_chosen",
      templateId: shown.template.id,
      rerollDepth: refinementRef.current.rerollDepth,
    });

    try {
      await markCooked(accessToken, shown.template.id, shown.substitutions);
    } catch {
      track({ name: "meal_choice_history_failed", templateId: shown.template.id });
    }

    // #137: the shopping list now lives at its own route so it survives a reload
    // and is reachable from the bottom nav — handed over via navigation state
    // rather than lifted into Gate, since TonightView already holds everything
    // `/lista` needs to render it (ListaRoute below).
    //
    // pantryIngredientIds rides along too (#200): Tonight's pantry row lets a
    // household mark what it has, but until now that selection was thrown away at
    // exactly this handoff — the guided flow's ingredients arrive from the server
    // pre-flagged `inPantry`, Tonight's do not, and nothing here re-attached the
    // household's own taps. ListaRoute below applies them.
    navigate("/lista", {
      state: {
        result: shown,
        portions: current.portions,
        diners: diners.parameter,
        pantryIngredientIds: refinementRef.current.pantryIngredientIds,
      },
    });
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

  /**
   * The one request shape every chip but "Annat kök" makes, plus the diner-change
   * effect below. `keep` and `previous` are never both passed by a caller — `keep`
   * is the diner-change "return this exact dish or explain why not" contract
   * (#133), `previous` is every other caller's plain reroll-diversity hint.
   */
  function requestSuggestion(next: RefinementState, previous: string | undefined, keep?: string) {
    return runRefinement(async () => {
      showResponse(
        await fetchTonight(accessToken, {
          exclude: next.excludedTemplateIds,
          previous,
          keep,
          weights: next.weights,
          pantry: next.pantryIngredientIds,
          diners: diners.parameter,
        }),
      );
    });
  }

  /**
   * A diner toggle re-asks with the new set, as an effect rather than inside the
   * toggle handler: the picker owns the selection, and reading it back synchronously
   * in the handler that changed it would read the previous value.
   *
   * The exclusion list survives the change. The household rejected those dishes on
   * their own merits, and who is at the table tonight does not make a dish they said
   * no to interesting again.
   *
   * This is a `keep` request (#133), not a `previous`-steered reroll: the household
   * did not ask for a different dish, so the server returns the exact one on screen
   * whenever the new diner set still allows it, and only picks (and explains) a
   * replacement when it does not.
   *
   * On failure the selection is put back. A failed refetch is the one case where the
   * picker and the card can disagree — the chips would show a diner set that the dish
   * behind them was never built for, which for a re-selected allergic member reads as
   * a claim the app has not checked. Reverting is the honest state: the card and the
   * picker describe the same meal again, with the error above them.
   */
  const requestedDinersRef = useRef(diners.parameter);
  const servedSelectionRef = useRef(diners.selection);
  useEffect(() => {
    if (requestedDinersRef.current === diners.parameter) return;

    const previousParameter = requestedDinersRef.current;
    const previousSelection = servedSelectionRef.current;
    const attempted = diners.selection;
    requestedDinersRef.current = diners.parameter;

    void requestSuggestion(refinementRef.current, undefined, current.result?.template.id).then((ok) => {
      if (ok) {
        servedSelectionRef.current = attempted;
        return;
      }
      // Restored *and* re-marked as the requested set, so putting the chips back does
      // not immediately re-trigger this effect and re-request what just failed.
      requestedDinersRef.current = previousParameter;
      diners.restore(previousSelection);
    });
    // Deliberately keyed on the diner set alone: this must fire when who is eating
    // changes and at no other time.
  }, [diners.parameter]);

  /**
   * A slider that has stopped moving re-ranks in place (#159).
   *
   * Keyed on `baseline.settled`, not the live per-notch value `PreferenceBlock` now
   * keeps to itself, so one drag is one request: `usePreferenceBaseline.onCommit`
   * fires once, on release, driving both the write and this. The dish on screen is
   * passed as `previous` exactly as a chip tap does, and `showResponse` swaps it only
   * once the new one has arrived — the screen never goes through an empty state, which
   * is where a household loses what they were just reading.
   *
   * The first settled value is the one that came back from the server on load, so the
   * ref starts there and this fires only on a real change.
   */
  const settledRef = useRef<PreferenceWeights | null>(null);
  useEffect(() => {
    if (!baseline.ready) return;
    // The first settled value is whatever the server already ranked this suggestion
    // with, so it is recorded and never acted on — re-requesting here would fire an
    // identical query on every mount and, worse, reroll the dish the household just
    // opened the app to see.
    if (settledRef.current === null) {
      settledRef.current = baseline.settled;
      return;
    }
    if (settledRef.current === baseline.settled) return;
    settledRef.current = baseline.settled;

    void requestSuggestion(refinementRef.current, current.result?.template.id);
    // Deliberately keyed on the settled baseline alone: this must fire when the
    // household's stored preference changes and at no other time.
  }, [baseline.settled, baseline.ready]);

  /** Resolves to whether the request succeeded — the diner effect above needs to know. */
  async function runRefinement(request: () => Promise<void>): Promise<boolean> {
    setFetchingNext(true);
    setNextError(null);
    try {
      await request();
      return true;
    } catch (err) {
      const presented = presentError(err, "tonight_refinement");
      setNextError(presented.kind === "offline" ? OFFLINE_MESSAGE : GENERIC_ERROR_MESSAGE);
      // A failed request never reaches `showResponse`, which is the only place
      // that otherwise clears this (#133) — left alone, a diner-change notice
      // would keep describing a dish this new, unrelated failure has nothing to
      // do with, sitting under an error about a completely different action.
      setDinerReplacedFor(undefined);
      return false;
    } finally {
      setFetchingNext(false);
    }
  }

  const CHIP_BY_AXIS: Record<WeightAxis, ChipId> = {
    price: "cheaper",
    time: "faster",
    variation: "try_new",
    simplicity: "simpler",
  };

  function handleToggle(axis: WeightAxis) {
    const next = apply({ type: "toggle_axis", axis });

    // `level` keeps its name in the analytics event (Phase 2 reads it to tell "turned
    // on" from "turned off") but is now 0/1, not 0/1/2 — there is no level any more.
    reportChipTap(CHIP_BY_AXIS[axis], next, isAxisActive(next, axis) ? 1 : 0);
    void requestSuggestion(next, current.result?.template.id);
  }

  /**
   * A pantry chip (#152). Re-ranks in place with the dish on screen kept as `previous`,
   * exactly like a chip tap — the household stated a fact about their cupboard, and the
   * answer is a re-ordered suggestion, never an empty screen while it loads.
   */
  function handleTogglePantry(ingredientId: string) {
    const next = apply({ type: "toggle_pantry", ingredientId });
    reportChipTap("pantry", next);
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
          fetchTonight(accessToken, {
            exclude,
            previous,
            weights: next.weights,
            pantry: next.pantryIngredientIds,
            diners: diners.parameter,
          }),
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
      <p className="text-eyebrow tonight-eyebrow">
        {weekdayLabel()} · {dinersLabel(current.diners)}
      </p>
      <h2 className="tonight-kicker">Ikväll</h2>
      {nextError && (
        <p role="alert" className="error-text">
          {nextError}
        </p>
      )}
      {/* #133: only ever rendered right after a diner change that could not keep the
          dish on screen — never a silent swap. `showResponse` clears this on every
          other response, so it cannot outlive the change that caused it. */}
      {dinerReplacedFor && (
        <p role="status" className="diner-replaced-notice">
          {dinerChangeReasonLine(dinerReplacedFor)}
        </p>
      )}
      {result === null && (
        <TonightEmptyState
          reason={current.reason}
          busy={fetchingNext}
          onReset={handleReset}
          onGoToProfile={() => navigate("/profil")}
        />
      )}
      {result !== null && (
        <>
          {/* Dimmed, never removed, while the next suggestion is on its way: the dish
              the household is reading stays on screen until the new one lands. An
              empty state here would cost them what they were mid-sentence on, for a
              request that usually takes a moment. */}
          <div className={fetchingNext ? "tonight-suggestion is-reranking" : "tonight-suggestion"}>
            <SuggestionCard
              result={result}
              swapBusy={fetchingNext}
              onChoose={() => void handleChooseTonight()}
              onSwap={handleSomethingElse}
            />
          </div>
          <section className="tonight-adjust">
            <p className="text-eyebrow">Justera</p>
            <AdjustmentChips
              refinement={refinement}
              busy={fetchingNext}
              onToggle={handleToggle}
              onOtherCuisine={handleOtherCuisine}
              onReset={handleReset}
            />
          </section>
          {fetchingNext && <p className="muted tonight-fetching">Hämtar…</p>}
        </>
      )}
      {/* Everything below gets quieter as it goes down the screen, and all of it sits
          under "Laga ikväll" (#152, #159): the adjustment chips, then the pantry row,
          then the collapsed preference block. A household that never scrolls past the
          button should not be able to tell any of it is here — Tonight exists to avoid
          input, not to offer a control panel. */}
      <PantryRow
        options={current.pantryIngredients ?? []}
        selected={refinement.pantryIngredientIds}
        busy={fetchingNext}
        onToggle={handleTogglePantry}
        onOpenAll={() => setPantrySheetOpen(true)}
      />
      {pantrySheetOpen && (
        <PantrySheet
          options={current.pantryIngredients ?? []}
          selected={refinement.pantryIngredientIds}
          onToggle={handleTogglePantry}
          onClose={() => setPantrySheetOpen(false)}
        />
      )}
      {
        // Under the card and the chips, never in front of them: Tonight is zero-input
        // and assumes everyone (DECISION_LOG 2026-08-09, condition 2), so this is a
        // refinement on a suggestion the household already has. Rendered in the empty
        // states too — "the child is eating at a grandparent's" is often the way out
        // of one.
        <DinerPicker state={diners} busy={fetchingNext} />
      }
      {/* Collapsed by default and last on the screen — it shows nothing but its own
          heading until somebody actually wants to steer (#159). Hidden entirely until
          the baseline has loaded: three sliders at zero would read as the household's
          own settings and invite a "correction" that overwrites what is really stored. */}
      {baseline.ready && (
        <PreferenceBlock
          settled={baseline.settled}
          onCommit={baseline.onCommit}
          collapsible
          disabled={fetchingNext}
        />
      )}
    </div>
  );
}

/**
 * `/bygg` (#137) — the guided flow unchanged, just wired to a real route: exiting
 * it now navigates back to Tonight instead of flipping a `view` variable. Its
 * `resume` prop is deliberately never passed here: Gate's own redirect (below)
 * now sends a device with any stored list straight to `/lista` before this ever
 * mounts, so GuidedFlow always starts fresh from here.
 */
function BuildRoute({ accessToken }: { accessToken: string }) {
  const navigate = useNavigate();
  return <GuidedFlow accessToken={accessToken} onExit={() => navigate("/")} />;
}

/**
 * A stored list, but with none of the live fetch data a fresh accept carries —
 * only what `shoppingListStorage.ts` persisted. Same reconstruction GuidedFlow's
 * own resume path used before #137; `/lista` is now the one place it happens.
 */
function resumedShoppingListMeal(stored: StoredShoppingList): ShoppingListMeal {
  return {
    template: { id: stored.templateId, name: stored.templateName ?? "Inköpslista" },
    ingredients: [],
    substitutions: stored.substitutions ?? [],
  };
}

/** The state TonightView's accept handler hands to `navigate("/lista", { state })`. */
interface AcceptedListingState {
  result: TonightResult;
  portions: number;
  diners?: string;
  /** What the household had marked on Tonight's pantry row at the moment of choice
   * (#200) — ingredient ids, forwarded to `ShoppingList` below so the list opens
   * with those items already in "Har hemma" instead of contradicting the dish's own
   * "valt för att ni har X hemma" reason line. Applied inside `ShoppingList` itself,
   * not here: it must land on top of whichever base list wins there (freshly built
   * or resumed from storage), or a household that accepts the same dish twice in one
   * session — reroll away, mark a new pantry item, accept again — finds its second
   * pantry tap silently ignored because a stored list for that template id already
   * won. */
  pantryIngredientIds?: readonly string[];
}

/**
 * `/lista` (#137 requirement 5) — always reachable from the bottom nav, unlike
 * the old inline rendering it replaces. Three states: a suggestion just accepted
 * on Tonight (carried via router navigation state, so a full reload still finds
 * it through `stored` below once the state is gone), a list already on the
 * device from an earlier session or the guided flow, or nothing at all yet.
 */
function ListaRoute({ accessToken }: { accessToken: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const accepted = location.state as AcceptedListingState | null;
  const [stored] = useState(() => (accepted ? null : loadAnyShoppingList()));

  if (accepted) {
    return (
      <ShoppingList
        result={accepted.result}
        pantryIngredientIds={accepted.pantryIngredientIds}
        explanation={
          suggestionReasonLine(accepted.result.reasonCodes ?? [], accepted.result.pantryMatch ?? []) ??
          undefined
        }
        portions={accepted.portions}
        diners={accepted.diners}
        accessToken={accessToken}
        onNewSuggestion={() => navigate("/")}
        onCook={() =>
          navigate(`/laga/${accepted.result.template.id}`, {
            state: cookMealFromResult(accepted),
          })
        }
      />
    );
  }

  if (stored) {
    return (
      <ShoppingList
        result={resumedShoppingListMeal(stored)}
        accessToken={accessToken}
        onNewSuggestion={() => navigate("/")}
        onCook={() => navigate(`/laga/${stored.templateId}`)}
      />
    );
  }

  return (
    <StateScreen
      variant="dashed"
      role="status"
      title="Ingen middag vald ännu"
      body="Välj kvällens middag så delar vi upp listan i vad du redan har hemma och vad du behöver handla."
      action={{ label: "Se förslag för ikväll", onClick: () => navigate("/") }}
    />
  );
}

/**
 * The cook screen's view of an accepted suggestion (#154). Every field is curated
 * or engine-computed — `prep_time_band` straight off the template, amounts already
 * scaled server-side — so nothing the model writes can reach the metadata row.
 */
function cookMealFromResult(accepted: AcceptedListingState): CookMeal {
  return {
    templateId: accepted.result.template.id,
    name: accepted.result.template.name,
    prepTimeBand: accepted.result.template.prep_time_band,
    portions: accepted.portions,
    ingredients: accepted.result.ingredients.map((ingredient) => ({
      name: ingredient.name,
      quantity: ingredient.quantity,
    })),
    substitutions: accepted.result.substitutions,
  };
}

/**
 * Rebuilds the dish for a `/laga/:id` opened without navigation state — a reload, a
 * bookmark, or an app started with no connection at all.
 *
 * The cook record is tried first because it is the only source that survives with no
 * shopping list on the device, and it carries the curated prep-time band. A stored
 * shopping list is the fallback; it has no band, and the metadata row omits the time
 * rather than estimating one from anywhere else.
 */
function resumeCookMeal(templateId: string): CookMeal | null {
  const record = loadLatestCookRecord(templateId);
  const stored = loadAnyShoppingList();

  // The shopping list wins whenever it is about this dish: it is the plan currently
  // in hand, with the amounts and swaps the household most recently asked for. A
  // cook record can be older — cook a dish for two, plan the same dish for five a
  // week later, and the record still holds the two-portion amounts.
  if (stored && stored.templateId === templateId) {
    const substitutions = stored.substitutions ?? [];
    // The band is the one thing the shopping list never stored, so it is borrowed
    // from the record — but only when the record describes this same substitution
    // set, since a different swap is a different dish.
    const sameDish = record?.substitutionKey === substitutionKey(substitutions);
    return {
      templateId,
      name: stored.templateName ?? record?.name ?? "Middagen",
      prepTimeBand: sameDish ? record?.prepTimeBand : undefined,
      portions: sameDish ? record?.portions : undefined,
      ingredients: stored.items.map((item) => ({ name: item.name, quantity: item.quantity })),
      substitutions,
    };
  }

  if (record) {
    return {
      templateId: record.templateId,
      name: record.name,
      prepTimeBand: record.prepTimeBand,
      portions: record.portions,
      ingredients: record.ingredients,
      substitutions: record.substitutions,
    };
  }

  return null;
}

/**
 * What the app shows when `fetchTonight` never reached the server at all.
 *
 * Route-aware, because "offline" is not one screen: a household that opened
 * `/laga/:id` is standing in a kitchen with the hob on, and bouncing them to the
 * shopping list because the network is down would be the app losing their place at
 * the worst possible moment (#154). The cook screen is rendered whenever the route
 * asks for it and the device can still describe the dish — with instructions from
 * `instructionsStorage` if they were fetched once before, and an honest "no
 * connection" under the ingredients if they were not.
 *
 * Every other route keeps #93/#137's behaviour unchanged: the saved shopping list if
 * there is one, otherwise the offline state screen.
 */
function OfflineFallback({
  list,
  accessToken,
  onRetry,
}: {
  list: StoredShoppingList | null;
  accessToken: string;
  onRetry: () => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const cookMatch = /^\/laga\/(.+)$/.exec(location.pathname);
  // Derived from the current path, not frozen at mount: while offline this component
  // stands in for the whole router, so "Till inköpslistan" and "← Ikväll" change the
  // pathname and nothing else — a memoised-at-mount meal would leave the cook screen
  // on display after the household asked to leave it.
  const meal = useMemo(
    () => (cookMatch ? resumeCookMeal(cookMatch[1]!) : null),
    [cookMatch?.[1]],
  );

  if (meal) {
    return (
      <CookScreen
        meal={meal}
        accessToken={accessToken}
        onBack={() => navigate("/")}
        onShoppingList={() => navigate("/lista")}
      />
    );
  }

  if (list) return <OfflineShoppingList list={list} />;

  return (
    <StateScreen
      variant="solid"
      role="status"
      title="Ingen anslutning"
      body="Anslut till internet för att komma igång."
      action={{ label: "Försök igen", onClick: onRetry }}
    />
  );
}

/** `/laga/:id` (#154) — the cook screen. */
function LagaRoute({ accessToken }: { accessToken: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { id } = useParams();
  const passed = location.state as CookMeal | null;

  // Resolved once, on mount: re-resolving on every render would re-read storage
  // mid-cook and could swap the dish out from under an active step.
  const [meal] = useState(() => (passed ?? (id ? resumeCookMeal(id) : null)));

  if (!meal || meal.templateId !== id) {
    return <CookScreenEmpty onBack={() => navigate("/")} />;
  }

  return (
    <CookScreen
      meal={meal}
      accessToken={accessToken}
      onBack={() => navigate("/")}
      onShoppingList={() => navigate("/lista")}
    />
  );
}

/** A household of one — plural "n barn"/"N vuxna" would jar next to it, and the
 *  reference writes it out for exactly this reason. */
function householdLabel(members: readonly HouseholdMember[]): string {
  const adults = members.filter((member) => member.type === "adult").length;
  const children = members.filter((member) => member.type === "child").length;
  const parts: string[] = [];
  if (adults > 0) parts.push(`${adults} ${adults === 1 ? "vuxen" : "vuxna"}`);
  if (children > 0) parts.push(`${children} barn`);
  return parts.join(" + ");
}

/** A stand-in for one collapsed member row while the profile screen's own fetch
 *  (never the Gate/onboarding data — see `fetchHousehold`'s comment) is in flight,
 *  sized to the real row's proportions rather than a spinner on empty space. */
function ProfileMemberRowSkeleton() {
  return (
    <div className="member-card" aria-hidden="true">
      <div className="skeleton-line skeleton-line--row" />
    </div>
  );
}

/**
 * One household member on the profile screen (#166): collapsed to a single
 * summary line — name, type, and *which* allergies apply — until "Ändra" opens
 * the same fields onboarding uses. Collapsed by default even for a freshly-added
 * member would hide the fields the household just asked to fill in, so
 * `expanded` is driven by the parent rather than defaulted here.
 */
function ProfileMemberRow({
  member,
  label,
  fallbackLabel,
  index,
  expanded,
  onToggle,
  onChange,
  onRemove,
  removable,
}: {
  member: HouseholdMember;
  label: string;
  fallbackLabel: string;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<HouseholdMember>) => void;
  onRemove: () => void;
  removable: boolean;
}) {
  return (
    <div className="member-card">
      <button
        type="button"
        className="profile-member-row"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="profile-member-row__summary">
          <span className="profile-member-row__name">{label}</span>
          <span className="profile-member-row__meta">
            {" · "}
            {TYPE_LABELS[member.type]}
          </span>
        </span>
        <span className="profile-member-row__action">{expanded ? "Stäng" : "Ändra"}</span>
      </button>

      {expanded && (
        <div className="profile-member-detail">
          <MemberDetailFields
            member={member}
            fallbackLabel={fallbackLabel}
            idPrefix={`profile-member-${index}`}
            onChange={onChange}
          />
          <Button type="button" variant="destructive" onClick={onRemove} disabled={!removable}>
            Ta bort {label}
          </Button>
        </div>
      )}
    </div>
  );
}

type ProfileLoadState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "offline" }
  | { status: "error"; code: string };

function toProfileLoadState(error: unknown): ProfileLoadState {
  const presented = presentError(error, "profile_load");
  return presented.kind === "offline" ? { status: "offline" } : { status: "error", code: presented.code };
}

const PROFILE_SAVE_ERROR_MESSAGE = "Det gick inte att spara ändringarna. Försök igen om en liten stund.";

/**
 * `/profil` (#166) — the household's real editing screen on top of
 * `GET`/`PUT /api/households` (#164/#165). The household is what this screen is
 * for, so it dominates: eyebrow, the household label as the heading, the rule the
 * screen rests on, then the members. Account controls (email, sign out, install)
 * move to `ProfileAccount` below, muted and separated at the bottom — they are not
 * why anyone opens this screen.
 *
 * Always fetches fresh on mount (`fetchHousehold`, never the Gate/onboarding
 * response) per the DECISION_LOG entry on PUT-as-full-replacement: a stale copy
 * held from an earlier screen could silently drop an allergy added elsewhere.
 */
function ProfilRoute({
  session,
  accessToken,
  onHouseholdUpdated,
  baseline,
}: {
  session: Session;
  accessToken: string;
  onHouseholdUpdated: () => Promise<void>;
  /**
   * The same baseline Tonight's collapsed block edits (#159) — one value, two views.
   * Expanded here, because the household came to this screen specifically to adjust
   * things, and written through its own route so a member save cannot wipe it.
   */
  baseline: PreferenceBaseline;
}) {
  const [loadState, setLoadState] = useState<ProfileLoadState>({ status: "loading" });
  const [members, setMembers] = useState<HouseholdMember[] | null>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadState({ status: "loading" });
    fetchHousehold(accessToken)
      .then((household) => {
        if (cancelled) return;
        setMembers(household.members);
        setOpenIndex(null);
        setLoadState({ status: "ready" });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadState(toProfileLoadState(error));
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, retryCount]);

  function updateMember(index: number, patch: Partial<HouseholdMember>) {
    setMembers((current) =>
      current ? current.map((member, i) => (i === index ? { ...member, ...patch } : member)) : current,
    );
  }

  function addMember() {
    // Computes the new member's index from `current`, the updater's own
    // argument, not the closed-over `members` — a double-tap before the first
    // add re-renders would otherwise have both calls read the same stale
    // length and open the same (first) newly-added member.
    setMembers((current) => {
      if (!current) return current;
      const next = [...current, emptyMember("adult")];
      setOpenIndex(next.length - 1);
      return next;
    });
  }

  function removeMember(index: number) {
    setMembers((current) => (current ? current.filter((_, i) => i !== index) : current));
    setOpenIndex((current) => {
      if (current === null) return current;
      if (current === index) return null;
      return current > index ? current - 1 : current;
    });
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!members) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateHousehold(accessToken, toHouseholdPayload(members));
      // Tonight must never keep showing a suggestion this edit may have made
      // unsafe — awaited so the request is in flight before the household can
      // navigate away, even though `Gate` applies the result itself.
      await onHouseholdUpdated();
    } catch (err) {
      const presented = presentError(err, "profile_save");
      setSaveError(presented.kind === "offline" ? OFFLINE_MESSAGE : PROFILE_SAVE_ERROR_MESSAGE);
    } finally {
      setSaving(false);
    }
  }

  const labels = members ? memberLabels(members) : [];
  const fallbackLabels = members
    ? memberLabels(members.map((member) => ({ ...member, name: undefined })))
    : [];

  return (
    <div className="profile-screen">
      <p className="text-eyebrow">Hushållet</p>
      <h1 className="screen-header__title">
        {members ? householdLabel(members) : "Laddar…"}
      </h1>
      <p className="profile-intro">
        Allergier är hårda uteslutningar. Preferenser påverkar rankningen.
      </p>

      {loadState.status === "offline" && (
        <StateScreen
          variant="solid"
          role="status"
          title="Ingen anslutning"
          body="Anslut till internet för att komma igång."
          action={{ label: "Försök igen", onClick: () => setRetryCount((n) => n + 1) }}
        />
      )}
      {loadState.status === "error" && (
        <StateScreen
          variant="solid"
          role="alert"
          title="Det gick inte att hämta hushållet"
          body={GENERIC_ERROR_MESSAGE}
          action={{ label: "Försök igen", onClick: () => setRetryCount((n) => n + 1) }}
          reference={loadState.code}
        />
      )}
      {loadState.status === "loading" && (
        <div className="profile-member-skeleton">
          <ProfileMemberRowSkeleton />
          <ProfileMemberRowSkeleton />
        </div>
      )}

      {loadState.status === "ready" && members && (
        <form onSubmit={(event) => void handleSave(event)}>
          <section>
            {members.map((member, index) => (
              <ProfileMemberRow
                key={index}
                member={member}
                label={labels[index]!}
                fallbackLabel={fallbackLabels[index]!}
                index={index}
                expanded={openIndex === index}
                onToggle={() => setOpenIndex((current) => (current === index ? null : index))}
                onChange={(patch) => updateMember(index, patch)}
                onRemove={() => removeMember(index)}
                removable={members.length > 1}
              />
            ))}
            <button type="button" className="member-add-row" onClick={addMember}>
              + Lägg till medlem
            </button>
          </section>

          <Button type="submit" variant="primary" className="profile-save" disabled={saving}>
            Spara
          </Button>
          {saveError && (
            <p role="alert" className="error-text">
              {saveError}
            </p>
          )}
        </form>
      )}

      {/* Outside the form on purpose (#159): the sliders write themselves through their
          own route the moment they settle, and putting them inside would make them look
          like they were waiting for "Spara" — which saves members, and must never be
          the thing that carries the weights. Expanded here, unlike Tonight's collapsed
          copy of the same block. */}
      {baseline.ready && (
        <PreferenceBlock settled={baseline.settled} onCommit={baseline.onCommit} />
      )}

      <ProfileAccount session={session} />
    </div>
  );
}

/** The account surface (#137) — email, sign out, install. Unchanged in function,
 *  just moved to the bottom and muted (#166): it's not why anyone opens this
 *  screen. */
function ProfileAccount({ session }: { session: Session }) {
  return (
    <div className="profile-account">
      <p className="muted">{session.user.email}</p>
      <Button type="button" variant="secondary" onClick={() => supabase.auth.signOut()}>
        Logga ut
      </Button>
      <InstallButton />
    </div>
  );
}

const ROUTE_EYEBROWS: Record<string, string> = {
  "/lista": "Inköpslista",
};

/**
 * The one `Screen`/`BottomNav` instance for all four tabs (#137) — a layout
 * route wrapping an `<Outlet/>`, not four separate `<Screen>` wrappers each
 * mounting their own nav. Tonight and the guided flow render their own inline
 * headers, so they carry no eyebrow here.
 */
function AppShell() {
  const location = useLocation();
  return (
    <Screen eyebrow={ROUTE_EYEBROWS[location.pathname]}>
      <Outlet />
    </Screen>
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
  | { status: "error"; code: string };

function toGateState(error: unknown): GateState {
  if (error instanceof ApiError && error.code === "household_not_found") {
    return { status: "no_household" };
  }
  const presented = presentError(error, "gate");
  return presented.kind === "offline"
    ? { status: "offline", list: loadAnyShoppingList() }
    : { status: "error", code: presented.code };
}

function Gate({ session }: { session: Session }) {
  const [state, setState] = useState<GateState>({ status: "checking" });
  const navigate = useNavigate();
  // Read through a ref inside the fetch callback: the redirect decision belongs to
  // the route the app was opened on, and adding `location` to the effect's
  // dependencies would re-run the whole Tonight fetch on every navigation.
  const location = useLocation();
  const pathnameRef = useRef(location.pathname);

  // Installs the real transport (issue #91) — analytics.ts's default sink just logs
  // in dev otherwise. Owned by Gate rather than by TonightView because switching to
  // the guided flow unmounts TonightView, and `handle.stop()` deliberately does not
  // flush: an owner that comes and goes with the view would drop up to one flush
  // interval of buffered events every time the household taps Bygg in the nav.
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

  // Owned here rather than in either screen, so Tonight's collapsed block and the
  // profile's section are two views of one value (#159). Both surfaces get the same
  // object; a change on either is a change to the household.
  const baseline = usePreferenceBaseline(
    session.access_token,
    state.status === "ready" ? state.data.preferenceWeights : undefined,
  );

  useEffect(() => {
    let cancelled = false;
    setState({ status: "checking" });

    fetchTonight(session.access_token)
      .then((data) => {
        if (cancelled) return;
        // A shopping list already on the device — Tonight's own suggestion just
        // accepted in an earlier session, or a dish chosen in the guided flow —
        // must be resumed at its own route on reload (UX_FLOW §7), not jumped into
        // the guided flow the way this used to work for a non-matching list
        // (#137, DECISION_LOG 2026-08-15). `replace` so this redirect doesn't leave
        // a phantom "/" the household never actually saw in the back-button history.
        //
        // Only from "/", which is the route this replaces. Any other path was asked
        // for explicitly — a reload on `/laga/:id` mid-cook, a bookmark, the back
        // button — and redirecting away from it would take the household somewhere
        // they did not ask to go, in the middle of cooking (#154).
        if (pathnameRef.current === "/" && loadAnyShoppingList()) {
          navigate("/lista", { replace: true });
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

  /**
   * A saved household edit (#166) must invalidate whatever Tonight is currently
   * holding — the suggestion on screen may contain an allergen the household just
   * added. Applied in place, `status` staying "ready" throughout: unlike
   * `handleCreated`, the household is on `/profil` when this fires, and switching
   * `status` away from "ready" would tear down the routed shell (and its nav)
   * out from under them for what should be an invisible background refresh.
   *
   * `TonightView` only reads `data` at mount, so this takes effect the moment the
   * household navigates back to "/" and it remounts — never by reaching into an
   * already-mounted instance. Invalidated to a null result *before* the refetch
   * rather than after: if the refetch itself fails (offline right after a
   * successful save), the stale suggestion must not be what's left on screen —
   * fail closed, not fail open.
   */
  async function handleHouseholdUpdated() {
    setState((current) =>
      current.status === "ready"
        ? {
            status: "ready",
            data: {
              result: null,
              reason: "household_updated",
              portions: current.data.portions,
              diners: current.data.diners,
            },
          }
        : current,
    );
    try {
      const data = await fetchTonight(session.access_token);
      setState((current) => (current.status === "ready" ? { status: "ready", data } : current));
    } catch {
      // Already invalidated above — left as the "no suggestion" state rather than
      // resurfacing a dish that may no longer be safe.
    }
  }

  // These four states pre-empt routing entirely and render the same regardless of
  // which URL the household is on — the offline/error/loading shell must open no
  // matter what (UX_FLOW §7), and none of them have a nav to route between yet.
  if (state.status !== "ready") {
    return (
      <div className="page">
        {state.status === "checking" && (
          <>
            <p className="muted sr-only">Laddar…</p>
            <SuggestionCardSkeleton />
          </>
        )}
        {state.status === "error" && (
          <StateScreen
            variant="solid"
            role="alert"
            title="Det gick inte att hämta kvällens förslag"
            body={GENERIC_ERROR_MESSAGE}
            action={{ label: "Försök igen", onClick: () => setRetryCount((n) => n + 1) }}
            reference={state.code}
          />
        )}
        {state.status === "offline" && (
          <OfflineFallback
            list={state.list}
            accessToken={session.access_token}
            onRetry={() => setRetryCount((n) => n + 1)}
          />
        )}
        {state.status === "no_household" && (
          <OnboardingForm session={session} onCreated={handleCreated} />
        )}
      </div>
    );
  }

  const accessToken = session.access_token;

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route
          path="/"
          element={<TonightView data={state.data} accessToken={accessToken} baseline={baseline} />}
        />
        <Route path="/bygg" element={<BuildRoute accessToken={accessToken} />} />
        <Route path="/lista" element={<ListaRoute accessToken={accessToken} />} />
        <Route path="/laga/:id" element={<LagaRoute accessToken={accessToken} />} />
        <Route
          path="/profil"
          element={
            <ProfilRoute
              session={session}
              accessToken={accessToken}
              onHouseholdUpdated={handleHouseholdUpdated}
              baseline={baseline}
            />
          }
        />
      </Route>
    </Routes>
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

  if (session === undefined) return <p className="page muted">Laddar…</p>;
  return (
    <BrowserRouter>
      {session === null ? (
        <div className="page">
          <LoginForm />
        </div>
      ) : (
        <Gate session={session} />
      )}
    </BrowserRouter>
  );
}
