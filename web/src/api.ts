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

export interface TonightResult {
  template: {
    id: string;
    name: string;
    cost_tier: CostTier;
    prep_time_band: PrepTimeBand;
    [key: string]: unknown;
  };
  ingredients: TonightIngredient[];
  substitutions: unknown[];
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

export async function fetchTonight(accessToken: string): Promise<TonightResponse> {
  const response = await fetch("/api/tonight", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const body: unknown = await response.json();

  if (!response.ok) {
    const { error } = body as ApiErrorEnvelope;
    throw new ApiError(response.status, error.code, error.message);
  }

  return body as TonightResponse;
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
