import type { RankingWeights } from "../engine/ranking.js";
import { HttpError } from "./httpError.js";

// Parses the session-scoped {cost, time} weight vector (DECISION_LOG 2026-07-31)
// from query parameters. A query parameter is the per-request form of that
// decision's "session-scoped, chip-driven, never persisted" vector — nothing here
// writes it anywhere, so it does not reintroduce the settings surface that decision
// rejected.
//
// { cost: 0, time: 0 }: the vector expresses what the household asked for *this
// session*, and a household that has tapped nothing has asked for nothing. Zero
// weights hand ordering entirely to familiarity and seasonality rather than
// assuming a budget preference the household never expressed — the assumption
// that was quietly making vegetarian, budget-tier dishes (lentils, chickpeas,
// beans) win by default (DECISION_LOG, ranking-defaults entry).
const DEFAULT_WEIGHTS: RankingWeights = { cost: 0, time: 0 };

function parseWeight(name: "cost" | "time", raw: unknown): number {
  if (raw === undefined) return DEFAULT_WEIGHTS[name];
  if (typeof raw !== "string") {
    throw new HttpError(400, "invalid_weights", `${name} must be a single numeric value`);
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new HttpError(400, "invalid_weights", `${name} must be a finite number >= 0`);
  }

  return value;
}

export function parseWeightsFromQuery(query: Record<string, unknown>): RankingWeights {
  return {
    cost: parseWeight("cost", query.cost),
    time: parseWeight("time", query.time),
  };
}
