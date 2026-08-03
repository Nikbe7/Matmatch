import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

// Smoke-level only, per CLAUDE.md: minimal UI/E2E investment until the core loop is
// validated. This proves the signed-out state renders the login form and never
// reaches the network — not a full auth-flow suite.

vi.mock("./supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}));

const { default: App } = await import("./App");

describe("App", () => {
  it("renders the login form when signed out", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
    });
    // Let the getSession() promise resolve and the resulting state update flush.
    await act(async () => {});

    expect(container.querySelector("form")).not.toBeNull();
    expect(container.textContent).toContain("Sign in");

    root.unmount();
    container.remove();
  });
});
