import { useEffect } from "react";

// Keeps the screen awake while the cook screen is open (#154). A phone that blanks
// mid-step is the single most likely way this screen fails in a real kitchen, where
// the household's hands are wet, full, or covered in flour.
//
// Silent degradation is the whole contract: `navigator.wakeLock` is unavailable in
// several browsers the app supports, and a request can be rejected outright (a
// background tab, low battery, a platform policy). None of that is worth a message —
// the screen still works, it just dims like any other page, and telling a household
// about a browser API it cannot act on is noise.

interface WakeLockSentinelLike {
  release(): Promise<void>;
}

interface WakeLockCapableNavigator {
  wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
}

export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    const wakeLock = (navigator as WakeLockCapableNavigator).wakeLock;
    if (!wakeLock) return;

    let sentinel: WakeLockSentinelLike | null = null;
    let released = false;

    async function acquire() {
      try {
        const next = await wakeLock!.request("screen");
        // The effect may have been torn down while the request was in flight —
        // releasing immediately is the only way not to leak the lock past unmount.
        if (released) {
          void next.release().catch(() => {});
          return;
        }
        sentinel = next;
      } catch {
        // Refused by the platform. Nothing to do and nothing to say.
      }
    }

    void acquire();

    // The browser drops the lock whenever the page is hidden, and does not restore
    // it on return — without this, switching to the timer app once permanently ends
    // the lock for the rest of the session. The release is silent, so `sentinel` has
    // to be cleared on the way out as well: leaving the stale handle in place would
    // make the re-acquire below look unnecessary and skip it.
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        sentinel = null;
        return;
      }
      if (!sentinel) void acquire();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      released = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
}
