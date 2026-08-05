// Single small module for backend calls, so the next slices (household onboarding,
// the real Tonight card) have one obvious place to add the next request. Reads the
// bearer token from the caller — it never touches the Supabase client or storage
// itself.

import type { Household } from "../../src/schema/household";
import type { CostTier } from "../../src/schema/ingredient";
import type { IngredientSlotRole, PrepTimeBand } from "../../src/schema/recipeTemplate";

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
    [key: string]: unknown;
  };
  ingredients: TonightIngredient[];
  substitutions: TonightSubstitution[];
  score: number;
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
}

export async function fetchTonight(
  accessToken: string,
  options: FetchTonightOptions = {},
): Promise<TonightResponse> {
  const params = new URLSearchParams();
  if (options.exclude && options.exclude.length > 0) params.set("exclude", options.exclude.join(","));
  if (options.previous) params.set("previous", options.previous);
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
