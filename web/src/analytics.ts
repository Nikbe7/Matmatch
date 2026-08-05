import type { SessionWeights } from "./api";
import type { ChipId } from "./refinement";

// The smallest thing that answers one Phase 2 question, and no more: when a
// household rerolls the Tonight card repeatedly, is that a *control* problem (the
// chips can't express what they want) or a *coverage* problem (the library has
// nothing that fits)? Chip taps plus final reroll depth separate the two. Without
// them that question gets settled by opinion, and the answer decides whether the
// customize-surface question from DECISION_LOG 2026-08-05 (chips) gets reopened.
//
// No dependency, no transport, no queue, no user id. There is no analytics backend
// yet; when there is one, it installs itself via `setAnalyticsSink` and nothing at
// the call sites changes. Deliberately not a generic event bus — two typed events,
// widened only when a real question needs a third.

export interface ChipTapEvent {
  name: "refinement_chip_tap";
  chip: ChipId;
  /** Weights *after* the tap, so a single event says what is now in effect. */
  weights: SessionWeights;
  rerollDepth: number;
}

/**
 * The session ended with suggestions shown but none accepted. `rerollDepth` is the
 * number this is all for: depth 0 is a household that walked away, depth 4+ is one
 * that tried and failed.
 */
export interface SessionAbandonedEvent {
  name: "refinement_session_abandoned";
  rerollDepth: number;
}

export type AnalyticsEvent = ChipTapEvent | SessionAbandonedEvent;

export type AnalyticsSink = (event: AnalyticsEvent) => void;

// `MODE` rather than `DEV`: the fallback should be visible while dogfooding but
// silent under vitest, which sets MODE to "test".
const defaultSink: AnalyticsSink = (event) => {
  if (import.meta.env.MODE === "development") {
    console.info("[analytics]", event);
  }
};

let sink: AnalyticsSink = defaultSink;

/** Installs a transport, or restores the default with `null`. */
export function setAnalyticsSink(next: AnalyticsSink | null): void {
  sink = next ?? defaultSink;
}

/**
 * Never throws and never blocks the interaction that produced the event — a
 * broken sink must not be able to break the refinement loop itself.
 */
export function track(event: AnalyticsEvent): void {
  try {
    sink(event);
  } catch {
    // Intentionally swallowed.
  }
}
