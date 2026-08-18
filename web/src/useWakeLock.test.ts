import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWakeLock } from "./useWakeLock";

// The failure this guards against is invisible in a browser and total: a screen that
// blanks mid-step, in a kitchen, with wet hands.

function stubWakeLock() {
  const release = vi.fn(() => Promise.resolve());
  const request = vi.fn(() => Promise.resolve({ release }));
  vi.stubGlobal("navigator", { ...navigator, wakeLock: { request } });
  return { request, release };
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  vi.unstubAllGlobals();
  setVisibility("visible");
});

describe("useWakeLock", () => {
  it("requests a screen lock while active", async () => {
    const { request } = stubWakeLock();
    renderHook(() => useWakeLock(true));

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("screen"));
  });

  it("does not request one when inactive", () => {
    const { request } = stubWakeLock();
    renderHook(() => useWakeLock(false));

    expect(request).not.toHaveBeenCalled();
  });

  it("releases on unmount", async () => {
    const { request, release } = stubWakeLock();
    const { unmount } = renderHook(() => useWakeLock(true));
    await vi.waitFor(() => expect(request).toHaveBeenCalled());

    unmount();
    await vi.waitFor(() => expect(release).toHaveBeenCalled());
  });

  it("re-acquires after the page is hidden and shown again", async () => {
    // The browser drops the lock on hide without telling us, so returning from the
    // timer app has to ask for it again — otherwise one app switch ends the lock for
    // the rest of the session.
    const { request } = stubWakeLock();
    renderHook(() => useWakeLock(true));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    setVisibility("hidden");
    setVisibility("visible");

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });

  it("degrades silently where the API does not exist", () => {
    vi.stubGlobal("navigator", {});
    expect(() => renderHook(() => useWakeLock(true))).not.toThrow();
  });

  it("degrades silently when the platform refuses", async () => {
    const request = vi.fn(() => Promise.reject(new Error("denied")));
    vi.stubGlobal("navigator", { wakeLock: { request } });

    expect(() => renderHook(() => useWakeLock(true))).not.toThrow();
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
  });
});
