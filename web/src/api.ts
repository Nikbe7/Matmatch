// Single small module for backend calls, so the next slices (household onboarding,
// the real Tonight card) have one obvious place to add the next request. Reads the
// bearer token from the caller — it never touches the Supabase client or storage
// itself.

import type { Household } from "../../src/schema/household";
import type { CostTier } from "../../src/schema/ingredient";
import type {
  Cuisine,
  EffortLevel,
  IngredientSlotRole,
  PrepTimeBand,
  QuantityUnit,
} from "../../src/schema/recipeTemplate";

/**
 * The session weight vector, structurally identical to `RankingWeights` in
 * `src/engine/ranking.ts` — declared here rather than imported because that module
 * reaches `src/engine/data.ts`, which imports `node:fs`. `web/` compiles without
 * Node types on purpose (a browser bundle should not be able to reach a filesystem
 * API), and pulling the engine's type in would mean relaxing that.
 *
 * Values are SLIDER NOTCHES (0–100, step 5) since #157, and what is sent is a session
 * *delta* on the household's persistent baseline — never an absolute weight vector. The
 * server owns the baseline and the combination; this file only ever says "and on top of
 * that, tonight, a bit more of this".
 *
 * All four axes are represented here since #153: every chip is a session delta on the
 * same axis its slider moves, never a parallel notion of the same idea. Drift is
 * caught immediately — an axis this file knows about and the server does not comes
 * back as a 400 from the first request that sends it.
 */
export interface SessionWeights {
  price: number;
  time: number;
  /**
   * "Testa nytt" (#153). The same axis the Variation slider moves, in the same notches
   * — the chip is a session delta on top of whatever the household set as its baseline,
   * never a parallel notion of "new".
   */
  variation: number;
  /**
   * "Enklare" (#153). The same axis the Enkelhet slider moves, in the same notches —
   * a session delta on top of the household's baseline, never a parallel mechanic.
   */
  simplicity: number;
}

/**
 * Structurally identical to `SuggestionReasonCode` in `src/engine/ranking.ts`,
 * declared here for the same reason `SessionWeights` is: that module reaches
 * `src/engine/data.ts`'s `node:fs` import, which `web/`'s browser tsconfig must not
 * resolve. The engine computes which codes apply (#122); this file only needs the
 * closed set of values it can receive.
 */
export type SuggestionReasonCode =
  | "pantry_match"
  | "in_season"
  | "not_recently_cooked"
  | "cost_preference"
  | "time_preference"
  | "different_from_last_time";

/**
 * One household member as the picker knows them: a display label at a position.
 *
 * Deliberately not the member — no dietary flags, no portion factor.
 * The client renders a control; it never holds a second copy of the household, which
 * is the last place a second source of truth about a household should exist.
 */
export interface DinerLabel {
  label: string;
}

/**
 * An amount already scaled to tonight's diners, or the explicit "efter smak" marker
 * (#123). Structured rather than a formatted string, exactly like `portions`: the
 * wording is the frontend's to choose (`formatQuantity`, display.ts).
 */
export type ScaledQuantity =
  | { kind: "amount"; amount: number; unit: QuantityUnit }
  | { kind: "to_taste" };

export interface TonightIngredient {
  role: IngredientSlotRole;
  name: string;
  /** The slot's position in the template's ingredient_slots[] (#124) — identifies
   * which slot a tap targets when asking for swap alternatives. */
  slotIndex: number;
  /** The id of the ingredient currently filling this slot (#124) — a bare
   * identifier, never the catalog row (see `name`'s comment on `TonightIngredientView`
   * server-side for why). */
  ingredientId: string;
  substituted: boolean;
  quantity: ScaledQuantity;
}

/**
 * One candidate the ingredient-swap popover can offer (#124) — role-matched, catalog-
 * gated, with the slot's own scaled quantity so applying it is "replace the item with
 * this view," no special-casing.
 */
export interface IngredientAlternative {
  ingredientId: string;
  name: string;
  costTier: CostTier;
  quantity: ScaledQuantity;
}

/**
 * The popover's whole answer for one slot. `cheaper`/`similar` are omitted rather
 * than empty when no candidate qualifies — the popover must not render a filter with
 * nothing behind it (#124 requirement 1). `searchPool` is the full role-valid catalog,
 * fetched once and filtered locally by typed query (the #110 idiom), so it is present
 * whenever `substitutable` is true, even as `[]`.
 */
export interface IngredientAlternativesResult {
  substitutable: boolean;
  cheaper?: IngredientAlternative[];
  similar?: IngredientAlternative[];
  searchPool?: IngredientAlternative[];
}

export async function fetchIngredientAlternatives(
  accessToken: string,
  templateId: string,
  slotIndex: number,
  ingredientId: string,
  /**
   * `diners` as the server spells it (see `FetchTonightOptions.diners`) — omitted
   * for everyone. Without this, the candidate set and quantities would come back
   * scoped to the whole household even when tonight's diner picker narrowed who is
   * eating, disagreeing with every other value already on screen.
   */
  diners?: string,
): Promise<IngredientAlternativesResult> {
  const params = new URLSearchParams({
    template: templateId,
    slot: String(slotIndex),
    ingredient: ingredientId,
  });
  if (diners) params.set("diners", diners);

  const response = await fetch(`/api/ingredients/alternatives?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const body: unknown = await response.json();

  if (!response.ok) {
    const { error } = body as ApiErrorEnvelope;
    throw new ApiError(response.status, error.code, error.message);
  }

  return body as IngredientAlternativesResult;
}

// Only the fields the frontend actually reads (slot_index + substitute_ingredient_id,
// forwarded verbatim to POST /api/instructions). The backend's SlotSubstitution also
// carries a `slot` object — allowed here as an excess property, never read.
export interface TonightSubstitution {
  slot_index: number;
  substitute_ingredient_id: string;
}

export interface TonightResult {
  template: {
    id: string;
    name: string;
    // #151: curated, shown under the dish name on Tonight. Never generated
    // client-side.
    blurb: string;
    cost_tier: CostTier;
    prep_time_band: PrepTimeBand;
    // #151/#161: curated, shown in the metadata row as a Swedish word, never as a
    // second dot meter (display.ts's `EFFORT_LEVEL_LABELS`).
    effort_level: EffortLevel;
    // Read by the "Annat kök" chip, which resolves cuisine to template-id
    // exclusions client-side rather than sending it as a request parameter.
    cuisine: Cuisine;
    [key: string]: unknown;
  };
  ingredients: TonightIngredient[];
  substitutions: TonightSubstitution[];
  score: number;
  // Why this dish, at most two codes, phrased by the client (#122). Never empty by
  // omission — an empty array is the engine's considered "nothing dominated" answer,
  // not a field that happened to be left off.
  reasonCodes: SuggestionReasonCode[];
  /**
   * The ingredient names behind a `pantry_match` code (#152), at most two, in the
   * household's own language — the card says "ni har spagetti och gul lök hemma".
   *
   * Present only alongside the code that earns it: the server omits it whenever the
   * pantry did not decide the pick, so the client never has to decide whether a name
   * list it was handed is a claim or leftovers.
   */
  pantryMatch?: string[];
  // Whether this household already marked *this* dish as cooked today (#88), so the
  // "Lagad ✓" state survives a reload. Deliberately one boolean about the dish on
  // screen rather than a recent-history list — there is no history screen, and the
  // penalty that uses the full history is applied server-side in ranking.
  cookedToday: boolean;
}

// portions is the household's raw total portion_factor — a plain number, never a
// preformatted string. Rounding and the "För N portioner" wording are frontend
// display logic (see App.tsx), not something the backend should own: baking the
// wording into the API would mean it could only change via an API change.
// `diners` is present on every response, empty state included — the picker is a
// refinement on whatever is on screen, and the §9 empty states are exactly where
// changing who is eating is most likely to be the way out.
//
// `replacedFor` (#133) is present only when a `keep` request (`FetchTonightOptions.keep`)
// could not honour the dish already on screen — the affected member's label, for
// `dinerChangeReasonLine` (display.ts) to render. Absent on every other response,
// including a plain `keep` success: its presence alone is what "was this
// replaced" means, so there is no separate boolean to keep in sync with it.
export type TonightResponse = (
  | { result: TonightResult }
  | { result: null; reason: string }
) & {
  portions: number;
  diners: DinerLabel[];
  /**
   * The staples this household is most likely to have, for Tonight's own pantry row
   * (#152) — the same list the guided flow's step-3 grid is built from, sent on every
   * response (empty states included) so the row survives a reroll without a second
   * request.
   */
  pantryIngredients?: IngredientOption[];
  /**
   * The household's stored slider baseline (#159), riding along with the suggestion it
   * ranked rather than fetched separately — the block on screen then cannot describe
   * different settings than the ones that produced the dish above it.
   */
  preferenceWeights?: PreferenceWeights;
  replacedFor?: string;
};

interface ApiErrorEnvelope {
  error: { code: string; message: string };
}

/** Mirrors the backend's HttpError: a status, a machine-readable code, a message. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface FetchTonightOptions {
  // Everything shown so far this session (App.tsx's React-state-only list) — never
  // read from or written to localStorage/the URL, per the ephemeral-session
  // principle in CLAUDE.md.
  exclude?: readonly string[];
  previous?: string;
  // The session weight vector the adjustment chips mutate (DECISION_LOG
  // 2026-07-31). Omitted entirely at the defaults so an untouched session sends no
  // weight parameters at all, matching the server's `{price: 0, time: 0}` default
  // rather than restating it here.
  weights?: SessionWeights;
  /**
   * `diners` as the server spells it: comma-separated member indices, or omitted
   * for everyone (#112). Built by `dinersParameter` — never assembled at a call
   * site, so there is one spelling of the default.
   */
  diners?: string;
  /**
   * The dish already on screen, sent only by a diner-set change (#133) — asks the
   * server to return this exact dish again if the new diner set still allows it,
   * and only pick (and explain) a replacement if it does not. Mutually exclusive
   * with `previous` in practice: a diner change is a "keep or explain" request,
   * never a reroll, so the caller sending `keep` has no reason to send `previous`
   * too.
   */
  keep?: string;
  /**
   * The ingredient ids the household tapped on Tonight's pantry row (#152). Session-
   * scoped and ephemeral by decision, exactly like `exclude`: held in React state,
   * never in localStorage, the URL or the household profile, so a reload starts empty.
   */
  pantry?: readonly string[];
}

export async function fetchTonight(
  accessToken: string,
  options: FetchTonightOptions = {},
): Promise<TonightResponse> {
  const params = new URLSearchParams();
  if (options.exclude && options.exclude.length > 0) params.set("exclude", options.exclude.join(","));
  if (options.previous) params.set("previous", options.previous);
  if (options.weights?.price) params.set("price", String(options.weights.price));
  if (options.weights?.time) params.set("time", String(options.weights.time));
  if (options.weights?.variation) params.set("variation", String(options.weights.variation));
  if (options.weights?.simplicity) params.set("simplicity", String(options.weights.simplicity));
  if (options.pantry && options.pantry.length > 0) params.set("pantry", options.pantry.join(","));
  if (options.diners) params.set("diners", options.diners);
  if (options.keep) params.set("keep", options.keep);
  const query = params.toString();

  const response = await fetch(`/api/tonight${query ? `?${query}` : ""}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const body: unknown = await response.json();

  if (!response.ok) {
    const { error } = body as ApiErrorEnvelope;
    throw new ApiError(response.status, error.code, error.message);
  }

  return body as TonightResponse;
}

// ---------------------------------------------------------------------------
// The guided quick-select flow (UX_FLOW §5). Deterministic end to end: every
// request below is answered by the Meal Engine over curated data, with no AI call
// anywhere in the path.
// ---------------------------------------------------------------------------

/** One tapable option in the main-ingredient or pantry grid. */
export interface IngredientOption {
  id: string;
  name: string;
}

export interface GuidedOptions {
  diners: DinerLabel[];
  mainIngredients: IngredientOption[];
  pantryIngredients: IngredientOption[];
}

export interface GuidedIngredient extends TonightIngredient {
  /** Something the household said it already has — seeds the "Har hemma" split. */
  inPantry: boolean;
}

export interface GuidedDirection {
  template: TonightResult["template"];
  ingredients: GuidedIngredient[];
  substitutions: TonightSubstitution[];
  /** A deterministic one-liner built from the dish's own ingredients, never generated. */
  summary: string;
  score: number;
}

/**
 * `reason` is present exactly when `directions` is empty, and says which empty
 * state to render: `no_directions` (this main ingredient/pantry combination is too
 * narrow — offer to loosen it) or `no_safe_templates` (the household's own
 * constraints leave nothing at all). Neither is an error, per UX_FLOW §9.
 */
export interface GuidedDirectionsResponse {
  directions: GuidedDirection[];
  reason?: string;
  mainIngredientId: string | null;
  portions: number;
  // Same contract as `TonightResponse.replacedFor` (#133): present only when a
  // `keep` request's dish had to be dropped from the returned cards, naming the
  // member it no longer fits.
  replacedFor?: string;
}

// The two guided endpoints are deliberately *not* exported from this module. They
// take a diner set that must be identical across the pair, and a plain exported
// function per endpoint makes a mismatched pair perfectly expressible. They live in
// guidedClient.ts behind a factory instead, which makes it inexpressible.

// The Tier 1 cooking-instructions result (issue #78). `instructions` is null on any
// generation failure — missing key, timeout, invalid AI response — never an error the
// caller has to catch; `reason` is machine-readable, shown as a fixed Swedish message
// by the caller, never rendered verbatim.
export interface InstructionsResult {
  instructions: string[] | null;
  reason?: string;
}

export async function fetchInstructions(
  accessToken: string,
  templateId: string,
  substitutions: readonly TonightSubstitution[],
): Promise<InstructionsResult> {
  const response = await fetch("/api/instructions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      templateId,
      substitutions: substitutions.map((substitution) => ({
        slot_index: substitution.slot_index,
        substitute_ingredient_id: substitution.substitute_ingredient_id,
      })),
    }),
  });

  const body: unknown = await response.json();

  if (!response.ok) {
    const { error } = body as ApiErrorEnvelope;
    throw new ApiError(response.status, error.code, error.message);
  }

  return body as InstructionsResult;
}

/**
 * Marks the dish on the Tonight card as cooked (#88).
 *
 * Safe to call twice: the backend collapses two taps on the same evening into one row
 * and answers 200 with the first tap's timestamp, so a retry after a flaky network is
 * never a duplicate entry and never an error the UI has to explain.
 */
export async function markCooked(
  accessToken: string,
  templateId: string,
  substitutions: readonly TonightSubstitution[],
): Promise<void> {
  const response = await fetch("/api/cooked", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      templateId,
      substitutions: substitutions.map((substitution) => ({
        slot_index: substitution.slot_index,
        substitute_ingredient_id: substitution.substitute_ingredient_id,
      })),
    }),
  });

  if (!response.ok) {
    const body: unknown = await response.json();
    const { error } = body as ApiErrorEnvelope;
    throw new ApiError(response.status, error.code, error.message);
  }
}

export async function createHousehold(accessToken: string, household: Household): Promise<void> {
  const response = await fetch("/api/households", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(household),
  });

  if (!response.ok) {
    const body: unknown = await response.json();
    const { error } = body as ApiErrorEnvelope;
    throw new ApiError(response.status, error.code, error.message);
  }
}

/**
 * The household's persistent preference baseline (#157/#159), as the two slider
 * surfaces read and write it.
 *
 * Structurally identical to `PreferenceWeights` in `src/schema/preferenceWeights.ts`,
 * declared here for the same reason `SessionWeights` is — that module is fine to
 * import, but keeping the client's own contract in one file is why every other server
 * type on this boundary is restated rather than reached for.
 *
 * `simplicity` has its own slider since #153, same as the other three.
 */
export interface PreferenceWeights {
  price: number;
  time: number;
  variation: number;
  simplicity: number;
}

export const NEUTRAL_PREFERENCE_WEIGHTS: PreferenceWeights = {
  price: 0,
  time: 0,
  variation: 0,
  simplicity: 0,
};

/**
 * Writes the baseline through its own route — never `PUT /api/households`.
 *
 * That route is a full replacement with no version check (DECISION_LOG 2026-08-16), so
 * routing a slider through it would mean the next profile save silently zeroed the
 * weights. The separation is the safeguard; do not "simplify" it into one call.
 */
export async function updatePreferenceWeights(
  accessToken: string,
  weights: PreferenceWeights,
): Promise<void> {
  const response = await fetch("/api/households/preferences", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(weights),
  });

  if (!response.ok) {
    const body: unknown = await response.json();
    const { error } = body as ApiErrorEnvelope;
    throw new ApiError(response.status, error.code, error.message);
  }
}

/**
 * The profile screen's own fetch (#166) — deliberately never cached or reused from
 * the onboarding/Gate flow. DECISION_LOG's PUT-as-full-replacement entry only holds
 * because every editing surface fetches fresh immediately before editing; a stale
 * copy here could silently drop a dietary flag the household added elsewhere.
 */
export async function fetchHousehold(accessToken: string): Promise<Household> {
  const response = await fetch("/api/households", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const body: unknown = await response.json();

  if (!response.ok) {
    const { error } = body as ApiErrorEnvelope;
    throw new ApiError(response.status, error.code, error.message);
  }

  return (body as { household: Household }).household;
}

/** Full replacement, same as `PUT /api/households` — never a partial patch. */
export async function updateHousehold(accessToken: string, household: Household): Promise<void> {
  const response = await fetch("/api/households", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(household),
  });

  if (!response.ok) {
    const body: unknown = await response.json();
    const { error } = body as ApiErrorEnvelope;
    throw new ApiError(response.status, error.code, error.message);
  }
}
