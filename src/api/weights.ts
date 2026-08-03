import type { RankingWeights } from "../engine/ranking.js";
import { HttpError } from "./httpError.js";

// Parses the session-scoped {cost, time} weight vector (DECISION_LOG 2026-07-31)
// from query parameters. A query parameter is the per-request form of that
// decision's "session-scoped, chip-driven, never persisted" vector — nothing here
// writes it anywhere, so it does not reintroduce the settings surface that decision
// rejected.

const DEFAULT_WEIGHTS: RankingWeights = { cost: 1, time: 1 };

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
