import type { AnalyticsEvent, AnalyticsSink } from "./analytics";

// The transport analytics.ts's own comment anticipates: buffers events in memory
// and POSTs them to /api/analytics/events on a short interval and on page hide
// (issue #91). Deliberately the simplest thing that gets events off the device:
//
// - No retry queue, no local persistence. A failed flush drops its batch — the
//   alternative (queueing for the next flush) risks an unbounded backlog on a
//   household with no connectivity, which is exactly what the buffer cap below
//   already exists to prevent one layer up.
// - track() (analytics.ts) already never throws, and flush()'s fetch failure is
//   swallowed here too, so a broken or slow analytics endpoint can never break the
//   interaction that produced the event.

const FLUSH_INTERVAL_MS = 10_000;

/** Oldest events are dropped past this — a long offline session cannot grow it. */
const MAX_BUFFERED_EVENTS = 50;

interface BufferedEvent {
  event: AnalyticsEvent;
  clientTimestamp: string;
}

export interface AnalyticsSinkHandle {
  sink: AnalyticsSink;
  /** Sends whatever is buffered right now. Safe to call with an empty buffer. */
  flush: () => void;
  /** Stops the interval and the page-hide listener. Does not flush. */
  stop: () => void;
}

/**
 * Builds a sink handle bound to one access token. Install its `sink` via
 * `setAnalyticsSink`; call `stop()` when the token is no longer valid (e.g. the
 * component that owns the session unmounts).
 */
export function createHttpAnalyticsSink(accessToken: string): AnalyticsSinkHandle {
  let buffer: BufferedEvent[] = [];

  function flush() {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];

    try {
      fetch("/api/analytics/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ events: batch }),
        // Lets the request outlive a page-hide flush rather than being cancelled
        // when the tab navigates away or closes.
        keepalive: true,
      })
        ?.then((response) => {
          // A non-2xx here means the server's event-shape mirror has drifted from
          // this client (#197) — a batch this shape was rejected and, per the module
          // comment, is already gone with no retry. Logging is the only way that
          // drift is ever seen; before this it shipped silently for months.
          if (!response.ok) {
            console.error(
              "[analytics] flush rejected",
              response.status,
              batch.map(({ event }) => event.name),
            );
          }
        })
        .catch(() => {
          // Drop on failure — no retry queue, no local persistence (see module comment).
        });
    } catch {
      // A synchronous throw from fetch itself (e.g. a broken test double, or an
      // environment without fetch) — same outcome as an async failure: the batch
      // is already gone from the buffer, and nothing propagates to the caller.
    }
  }

  const intervalId = window.setInterval(flush, FLUSH_INTERVAL_MS);
  window.addEventListener("pagehide", flush);

  const sink: AnalyticsSink = (event) => {
    buffer.push({ event, clientTimestamp: new Date().toISOString() });
    if (buffer.length > MAX_BUFFERED_EVENTS) {
      buffer.splice(0, buffer.length - MAX_BUFFERED_EVENTS);
    }
  };

  return {
    sink,
    flush,
    stop: () => {
      window.clearInterval(intervalId);
      window.removeEventListener("pagehide", flush);
    },
  };
}
