import {
  ApiError,
  type GuidedDirectionsResponse,
  type GuidedOptions,
} from "./api";

// The guided flow's two endpoints, bound to one diner set (#112).
//
// Both endpoints must run on the *same* diners. `/api/guided/options` builds the
// ingredient grid from the safe candidate set, and `/api/guided/directions` filters
// again from scratch on every request — so a mismatched pair is not a safety hole,
// but it is a broken screen: the grid offers a tap target that the directions request
// then refuses, and the household gets the §9 empty state for a choice the app just
// invited them to make.
//
// Two separate GETs mean the server cannot enforce the pairing. Rather than document
// a rule and hope, this factory makes the mismatch inexpressible: the diner set is
// supplied once, here, and neither returned function accepts one. There is no call
// you can write in which the grid and the directions disagree.
//
// Changing the diner set means building a new client, which is exactly right — the
// grid has to be rebuilt for the new set anyway.

export interface GuidedClient {
  fetchOptions(): Promise<GuidedOptions>;
  fetchDirections(options: GuidedDirectionsRequest): Promise<GuidedDirectionsResponse>;
}

export interface GuidedDirectionsRequest {
  intent: string;
  /** An ingredient id, `auto` ("Föreslå åt mig") or `any` (the §9 loosen path). */
  main: string;
  /**
   * Session-scoped pantry ingredient ids. Sent per request and never stored: this
   * module holds no pantry state and `shoppingListStorage.ts` never sees an id.
   */
  pantry?: readonly string[];
  /**
   * The already-chosen direction's template id (#133), same contract as
   * `FetchTonightOptions.keep`: keep it if the diner set this client was built
   * for still allows it, replace (and explain) it if not.
   */
  keep?: string;
}

interface ApiErrorEnvelope {
  error: { code: string; message: string };
}

async function readJson<T>(response: Response): Promise<T> {
  const body: unknown = await response.json();

  if (!response.ok) {
    const { error } = body as ApiErrorEnvelope;
    throw new ApiError(response.status, error.code, error.message);
  }

  return body as T;
}

/**
 * @param diners the `diners` query parameter, or `undefined` for the whole household
 *   — built by `dinersParameter`, never assembled at a call site.
 */
export function createGuidedClient(accessToken: string, diners: string | undefined): GuidedClient {
  const headers = { Authorization: `Bearer ${accessToken}` };

  /** The one place the diner set reaches a URL in this flow. */
  function withDiners(params: URLSearchParams): string {
    if (diners) params.set("diners", diners);
    const query = params.toString();
    return query ? `?${query}` : "";
  }

  return {
    async fetchOptions() {
      const response = await fetch(`/api/guided/options${withDiners(new URLSearchParams())}`, {
        headers,
      });
      return readJson<GuidedOptions>(response);
    },

    async fetchDirections(options) {
      const params = new URLSearchParams({ intent: options.intent, main: options.main });
      if (options.pantry && options.pantry.length > 0) {
        params.set("pantry", options.pantry.join(","));
      }
      if (options.keep) params.set("keep", options.keep);

      const response = await fetch(`/api/guided/directions${withDiners(params)}`, { headers });
      return readJson<GuidedDirectionsResponse>(response);
    },
  };
}
