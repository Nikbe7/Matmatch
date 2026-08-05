// Single small module for backend calls, so the next slices (household onboarding,
// the real Tonight card) have one obvious place to add the next request. Reads the
// bearer token from the caller — it never touches the Supabase client or storage
// itself.

import type { Household } from "../../src/schema/household";
import type { CostTier } from "../../src/schema/ingredient";
import type { Cuisine, IngredientSlotRole, PrepTimeBand } from "../../src/schema/recipeTemplate";

/**
 * The session weight vector, structurally identical to `RankingWeights` in
 * `src/engine/ranking.ts` — declared here rather than imported because that module
 * reaches `src/engine/data.ts`, which imports `node:fs`. `web/` compiles without
 * Node types on purpose (a browser bundle should not be able to reach a filesystem
 * API), and pulling the engine's type in would mean relaxing that.
 *
 * Two numeric axes that the 2026-07-31 decision fixes in place is about as stable
 * as a shape gets, and drift is caught immediately: an axis this file knows about
 * and the server does not comes back as a 400 from the first request that sends it.
 */
export interface SessionWeights {
  cost: number;
  time: number;
}

export interface TonightIngredient {
  role: IngredientSlotRole;
  name: string;
  substituted: boolean;
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
    cost_tier: CostTier;
    prep_time_band: PrepTimeBand;
    // Read by the "Annat kök" chip, which resolves cuisine to template-id
    // exclusions client-side rather than sending it as a request parameter.
    cuisine: Cuisine;
    [key: string]: unknown;
  };
  ingredients: TonightIngredient[];
  substitutions: TonightSubstitution[];
  score: number;
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
export type TonightResponse =
  | { result: TonightResult; portions: number }
  | { result: null; reason: string; portions: number };

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
  // weight parameters at all, matching the server's `{cost: 0, time: 0}` default
  // rather than restating it here.
  weights?: SessionWeights;
}

export async function fetchTonight(
  accessToken: string,
  options: FetchTonightOptions = {},
): Promise<TonightResponse> {
  const params = new URLSearchParams();
  if (options.exclude && options.exclude.length > 0) params.set("exclude", options.exclude.join(","));
  if (options.previous) params.set("previous", options.previous);
  if (options.weights?.cost) params.set("cost", String(options.weights.cost));
  if (options.weights?.time) params.set("time", String(options.weights.time));
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
