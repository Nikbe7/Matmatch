import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuidedClient } from "./guidedClient";

// The guided flow's two endpoints must run on one diner set (#112). The factory makes
// a mismatched pair inexpressible rather than merely discouraged, so these tests check
// both halves of that claim: the diner set only ever enters through the factory, and
// whatever enters there reaches both endpoints identically.

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function stubFetch() {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    jsonResponse({ diners: [], mainIngredients: [] }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function urls(fetchMock: ReturnType<typeof stubFetch>): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createGuidedClient", () => {
  it("sends the same diner set to both endpoints", async () => {
    const fetchMock = stubFetch();
    const client = createGuidedClient("token-123", "0,2");

    await client.fetchOptions();
    await client.fetchDirections({ intent: "dinner_idea", main: "lax" });

    for (const url of urls(fetchMock)) {
      expect(new URLSearchParams(url.split("?")[1]).get("diners")).toBe("0,2");
    }
  });

  it("sends no diner parameter at all when everyone is eating", async () => {
    const fetchMock = stubFetch();
    const client = createGuidedClient("token-123", undefined);

    await client.fetchOptions();
    await client.fetchDirections({ intent: "dinner_idea", main: "auto" });

    expect(urls(fetchMock)[0]).toBe("/api/guided/options");
    for (const url of urls(fetchMock)) {
      expect(new URLSearchParams(url.split("?")[1] ?? "").get("diners")).toBeNull();
    }
  });

  it("neither endpoint accepts a diner set, so a divergent pair cannot be written", () => {
    // The type-level guarantee, restated at runtime as far as it can be: the diner
    // set is a *closure* variable, reachable only through the factory. `fetchOptions`
    // takes no argument at all, and `fetchDirections` takes a request object with no
    // diner field — TypeScript rejects one (an excess property), and this asserts the
    // shape those types describe so a later widening of the type is not silent.
    const client = createGuidedClient("token-123", "0");

    expect(client.fetchOptions.length).toBe(0);
    // @ts-expect-error — there is no diner set to pass here. Removing this parameter
    // from the type would be the change that reopens the mismatch; the compiler error
    // is the test.
    void ((request: Parameters<typeof client.fetchDirections>[0]) => request.diners);
  });

  it("two clients are needed for two diner sets, and neither can be repointed", async () => {
    const fetchMock = stubFetch();
    const everyone = createGuidedClient("token-123", undefined);
    const withoutElsa = createGuidedClient("token-123", "0");

    await everyone.fetchOptions();
    await withoutElsa.fetchOptions();

    expect(new URLSearchParams(urls(fetchMock)[0]!.split("?")[1] ?? "").get("diners")).toBeNull();
    expect(new URLSearchParams(urls(fetchMock)[1]!.split("?")[1]).get("diners")).toBe("0");
  });

  it("keeps the pantry and intent parameters alongside the diner set", async () => {
    const fetchMock = stubFetch();
    const client = createGuidedClient("token-123", "1");

    await client.fetchDirections({
      intent: "use_what_i_have",
      main: "any",
      pantry: ["ris", "gul-lok"],
    });

    const query = new URLSearchParams(urls(fetchMock)[0]!.split("?")[1]);
    expect(query.get("intent")).toBe("use_what_i_have");
    expect(query.get("main")).toBe("any");
    expect(query.get("pantry")).toBe("ris,gul-lok");
    expect(query.get("diners")).toBe("1");
  });

  it("sends the bearer token on both endpoints", async () => {
    const fetchMock = stubFetch();
    const client = createGuidedClient("token-123", "0");

    await client.fetchOptions();
    await client.fetchDirections({ intent: "dinner_idea", main: "auto" });

    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.headers).toEqual({ Authorization: "Bearer token-123" });
    }
  });
});
