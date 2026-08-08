import { z } from "zod";
import type { RankingWeights } from "../engine/ranking.js";
import { HttpError } from "./httpError.js";

// The guided flow's intent chips (UX_FLOW §5 step 1) and what each one actually
// does to the engine.
//
// The governing rule for this file: an intent may only pull a lever the engine
// already has. Every chip below resolves to a `RankingWeights` vector the existing
// `rankCandidates` understands plus, at most, a selection preference `directions.ts`
// applies on top of the ranked order. No chip introduces a ranking dimension, a new
// template field or a new filter — a chip with nothing real behind it is not shipped
// at all, which is why UX_FLOW's sixth chip ("Matlådor") is absent: it needs a
// household lunch-box count and a keeps/reheats signal that do not exist. See the
// DECISION_LOG entry for this flow and the follow-up issue.

export const GuidedIntentSchema = z.enum([
  "dinner_idea",
  "cheap",
  "use_what_i_have",
  "high_protein",
  "surprise_me",
]);
export type GuidedIntent = z.infer<typeof GuidedIntentSchema>;

export interface IntentParameters {
  weights: RankingWeights;
  preferHighProtein: boolean;
}

// The weight a maxed adjustment chip carries — `WEIGHT_LEVELS[2]` in
// web/src/refinement.ts, calibrated in src/engine/ranking.ts to beat the largest
// possible familiarity gap. "Billigt" is an explicit, unambiguous statement about
// cost, so it starts where the Tonight card's "Billigare" chip *ends* rather than at
// a timid level 1. Re-derive alongside WEIGHT_LEVELS if that scale ever changes.
const MAX_CHIP_WEIGHT = 3;

const NEUTRAL: RankingWeights = { cost: 0, time: 0 };

/**
 * What an intent chip means to the engine.
 *
 *  * `dinner_idea` — the honest default: no expressed preference, so ordering falls
 *    to familiarity and seasonality exactly as it does for an untouched Tonight card.
 *  * `cheap` — the one chip with a direct numeric lever.
 *  * `use_what_i_have` — deliberately neutral here. Its entire lever is the pantry
 *    step, applied as coverage bucketing in `pickDirections`; adding a weight on top
 *    would be inventing a second meaning for the chip.
 *  * `high_protein` — a selection preference over `high_protein_preference`-tagged
 *    templates. Not a filter (only 13 dinner templates carry the tag before allergies)
 *    and not a score term (`scoreCandidate` deliberately has none).
 *  * `surprise_me` — neutral weights; what makes it a surprise is that the flow skips
 *    the main-ingredient and pantry steps and lets the engine pick, not a different
 *    ranking. Randomness is deliberately absent: it would be a new dimension, and an
 *    app that answers differently on two identical taps reads as indecisive.
 */
export function intentParameters(intent: GuidedIntent): IntentParameters {
  switch (intent) {
    case "cheap":
      return { weights: { cost: MAX_CHIP_WEIGHT, time: 0 }, preferHighProtein: false };
    case "high_protein":
      return { weights: NEUTRAL, preferHighProtein: true };
    case "dinner_idea":
    case "use_what_i_have":
    case "surprise_me":
      return { weights: NEUTRAL, preferHighProtein: false };
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}

export function parseIntentFromQuery(raw: unknown): GuidedIntent {
  if (typeof raw !== "string") {
    throw new HttpError(400, "invalid_intent", "intent must be a single string value");
  }

  const parsed = GuidedIntentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(
      400,
      "invalid_intent",
      `intent must be one of: ${GuidedIntentSchema.options.join(", ")}`,
    );
  }

  return parsed.data;
}
