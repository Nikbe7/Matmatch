// Single small module for backend calls, so the next slices (household onboarding,
// the real Tonight card) have one obvious place to add the next request. Reads the
// bearer token from the caller — it never touches the Supabase client or storage
// itself.

export interface TonightResult {
  template: {
    name: string;
    cost_tier: string;
    prep_time_band: string;
    [key: string]: unknown;
  };
  substitutions: unknown[];
  score: number;
}

export type TonightResponse = { result: TonightResult } | { result: null; reason: string };

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
