import type { SessionWeights } from "./api";
import type { ChipId } from "./refinement";

// The smallest thing that answers one Phase 2 question, and no more: when a
// household rerolls the Tonight card repeatedly, is that a *control* problem (the
// chips can't express what they want) or a *coverage* problem (the library has
// nothing that fits)? Chip taps plus final reroll depth separate the two. Without
// them that question gets settled by opinion, and the answer decides whether the
// customize-surface question from DECISION_LOG 2026-08-05 (chips) gets reopened.
//
// This module owns the event vocabulary only — no transport, no queue, no user id.
// The real sink (buffering, batching, POSTing to the backend) lives in
// analyticsSink.ts and is installed via `setAnalyticsSink` from App.tsx; nothing at
// the call sites below knows or cares which sink is active. Deliberately not a
// generic event bus — a small set of typed events, widened only when a real
// question needs another one.

export interface ChipTapEvent {
  name: "refinement_chip_tap";
  chip: ChipId;
  /** Weights *after* the tap, so a single event says what is now in effect. */
  weights: SessionWeights;
  /**
   * The 0–2 level the tapped axis is now at, alongside its raw weight — separates
   * "tapped once" from "tapped to max" without every consumer having to know the
   * weight-to-level mapping in `refinement.ts`. Absent for chips with no axis
   * (`other_cuisine`, `something_else`, `reset`).
   */
  level?: number;
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

/**
 * The household chose "Laga ikväll" (#88, renamed from `meal_cooked` by #142's
 * accept/cooked merge, DECISION_LOG 2026-08-16) — the closest thing the app has to a
 * completed loop, and therefore the event the roadmap's Weekly Active Deciders and
 * repeat-use metrics are counted from. This is the third event the module comment
 * reserves: a real question needs it, not symmetry with the two above.
 *
 * Fires at the moment of choice, not at a later confirmed-cooked step — there is no
 * such step any more. A household that chooses a dish and then orders pizza instead
 * still produces this event; the name says "chosen", not "cooked", precisely so a
 * reader of the analytics data does not assume otherwise.
 *
 * `rerollDepth` comes along because "chose the first suggestion" and "chose the sixth"
 * are the same outcome reached very differently, and that difference is the same
 * control-vs-coverage question the chip events exist to answer.
 */
export interface MealChosenEvent {
  name: "meal_chosen";
  templateId: string;
  rerollDepth: number;
}

/**
 * The `POST /api/cooked` call behind a "Laga ikväll" tap failed — the history write
 * that suppresses this dish from ranking for about two weeks (#88) did not happen,
 * though the household still went on to the shopping list (DECISION_LOG 2026-08-16).
 * Nothing the household can act on, so the UI swallows the error; this is the only
 * record that the write is missing, for anyone later reconciling `meal_chosen` counts
 * against actual repeat-avoidance behaviour.
 */
export interface MealChoiceHistoryFailedEvent {
  name: "meal_choice_history_failed";
  templateId: string;
}

/**
 * Where a raw server error code was swallowed before it could reach the
 * household — the redesigned error states (issue #170) never render a code or
 * a server message as body text, so this is the only place the code survives
 * for anyone debugging a spike in a particular failure. `context` names the
 * screen or request that failed, not the code's meaning — several contexts can
 * share the same code.
 */
export interface AppErrorShownEvent {
  name: "app_error_shown";
  context:
    | "gate"
    | "onboarding"
    | "profile_load"
    | "profile_save"
    | "tonight_no_result"
    | "tonight_refinement"
    | "guided_options"
    | "guided_directions"
    | "guided_diner_change"
    | "instructions";
  code: string;
}

/** The longest query worth recording. Past this it is a paste or a cat on the keyboard,
 *  not a household looking for dinner, and the column should not carry it. */
export const MAX_LOGGED_QUERY_LENGTH = 64;

/**
 * Step 2's filter ran and reached nothing, or reached exactly one thing (#255).
 *
 * The question it answers is the one that decides whether the catalog needs authoring
 * at all: when a household types something and gets nowhere, is that a **gap** (no such
 * dish exists) or a **miss** (it exists and the index could not be pointed at it)?
 * #259 widened the index precisely because a large share of what looked like gaps were
 * misses; without this event the split between what remains is guesswork, and #253/#254
 * would be authoring against a hunch.
 *
 * One result counts as a miss too: a query that reaches a single ingredient gives a
 * household no choice, which is the same dead end wearing a better face.
 *
 * This is the only event carrying free text, and it stays the only one. The query is
 * trimmed and capped at `MAX_LOGGED_QUERY_LENGTH`; nothing else about the household,
 * its members or its pantry rides along. `analytics_events` holds no PII beyond
 * `household_id` (ARCHITECTURE §5) and that is not weakened here.
 */
export interface MainSearchMissEvent {
  name: "main_search_miss";
  /** As typed, trimmed and capped. */
  query: string;
  /** 0 or 1 — how many eligible ingredients the query reached. */
  matchCount: number;
}

/**
 * A shopping list with the household's own work in it was replaced by a new dish's
 * list (#202), and the undo offer was shown.
 *
 * Paired with `ShoppingListRestoredEvent` below, and the pair exists to answer one
 * question with evidence rather than opinion: if restores turn out to be common, that
 * is the trigger for multi-dish lists. If they are rare, single-dish lists are right
 * and the undo is enough. No dish names or ingredients ride along — `itemCount` and
 * the template id are what the union already carries elsewhere.
 */
export interface ShoppingListReplacedEvent {
  name: "shopping_list_replaced";
  /** The dish whose list was displaced. */
  templateId: string;
  /** How many rows the displaced list held. */
  itemCount: number;
}

/** The household took the undo (#202). */
export interface ShoppingListRestoredEvent {
  name: "shopping_list_restored";
  /** The dish whose list came back. */
  templateId: string;
}

export type AnalyticsEvent =
  | ChipTapEvent
  | SessionAbandonedEvent
  | MealChosenEvent
  | MealChoiceHistoryFailedEvent
  | AppErrorShownEvent
  | MainSearchMissEvent
  | ShoppingListReplacedEvent
  | ShoppingListRestoredEvent;

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
