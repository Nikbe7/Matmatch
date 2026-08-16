import type { CostTier } from "../../src/schema/ingredient";
import type { IngredientSlotRole, PrepTimeBand, QuantityUnit } from "../../src/schema/recipeTemplate";
import type { ScaledQuantity, SuggestionReasonCode } from "./api";

// Display mappings for curated engine enums, shared by every screen that renders a
// dish — the Tonight card and the guided flow's direction cards. One definition, so
// a cost tier can never mean one thing on one screen and something else on another.
//
// Split out of App.tsx when the guided flow needed the same mappings: importing them
// from App.tsx would have made App and GuidedFlow import each other.

// Display-only mapping (DECISION_LOG 2026-07-29, amended for the dot meter): the
// dots are never the underlying cost_tier value and never stand in for an invented
// kronor figure. An exhaustive switch means a new tier value fails typecheck here
// rather than silently rendering nothing.
export function costTierMeter(tier: CostTier): string {
  switch (tier) {
    case "budget":
      return "●○○";
    case "mid":
      return "●●○";
    case "premium":
      return "●●●";
    default: {
      const exhaustive: never = tier;
      return exhaustive;
    }
  }
}

// The dot meter is purely visual — a screen reader must announce this word, not
// three bullet characters, so cards wire this in as an aria-label rather than
// relying on the dot string's own accessible name.
export function costTierLabel(tier: CostTier): string {
  switch (tier) {
    case "budget":
      return "Billig";
    case "mid":
      return "Mellan";
    case "premium":
      return "Dyr";
    default: {
      const exhaustive: never = tier;
      return exhaustive;
    }
  }
}

export const PREP_TIME_LABELS: Record<PrepTimeBand, string> = {
  "<20min": "Under 20 min",
  "20-40min": "20–40 min",
  "40min+": "Över 40 min",
};

export const INGREDIENT_ROLE_LABELS: Record<IngredientSlotRole, string> = {
  protein: "Protein",
  starch: "Stärkelse",
  vegetable: "Grönsak",
  aromatic: "Arom",
  dairy: "Mejeri",
};

// #122: the Tonight card's one-line "why this dish". Each phrase is written to
// read as the tail of a sentence ("Valt för att den är …"), never as a standalone
// label — see `suggestionReasonLine` below, the only place these are joined.
const SUGGESTION_REASON_PHRASES: Record<SuggestionReasonCode, string> = {
  in_season: "den är i säsong",
  not_recently_cooked: "ni inte lagat den på ett tag",
  cost_preference: "den är billigare, som du bad om",
  time_preference: "den är snabbare, som du bad om",
  different_from_last_time: "den är annorlunda än ikväll ni lagade senast",
};

/**
 * The Tonight card's explanation line, or `null` for silence (#122 requirement 2) —
 * never an empty string, so a caller can `&&` on the result without also checking
 * length. At most two reason codes ever reach here (`explainSuggestion`,
 * src/engine/ranking.ts), so this never has to decide how to truncate a longer list.
 */
export function suggestionReasonLine(codes: readonly SuggestionReasonCode[]): string | null {
  if (codes.length === 0) return null;
  const phrases = codes.map((code) => SUGGESTION_REASON_PHRASES[code]);
  return `Valt för att ${phrases.join(" och ")}.`;
}

/**
 * #133: the line shown when a diner-set change replaces the dish on screen —
 * "Rätten passar inte Elsa, här är ett nytt förslag". Never rendered from a bare
 * boolean: the server only ever sends the affected member's label when a
 * replacement actually happened (`TonightResponse.replacedFor` /
 * `GuidedDirectionsResponse.replacedFor`), so its presence is the one thing this
 * function needs — there is no separate "was it replaced" flag to keep in sync
 * with it.
 */
export function dinerChangeReasonLine(memberLabel: string): string {
  return `Rätten passar inte ${memberLabel}, här är ett nytt förslag`;
}

// #123: how a scaled quantity is worded on the shopping list. The amount itself
// arrives already scaled and rounded from the engine (src/engine/quantities.ts) —
// nothing here changes a number, it only writes it in Swedish.
const PLURAL_UNIT_FORMS: Partial<Record<QuantityUnit, string>> = {
  klyfta: "klyftor",
  kruka: "krukor",
};

/**
 * "600 g", "1,5 dl", "2 klyftor", "efter smak".
 *
 * A Swedish decimal comma, not a point: this is read in a shop by a person, and
 * "1.5 dl" is the kind of small wrongness that makes an app feel translated. Only
 * `klyfta` and `kruka` inflect — the measuring units (g, dl, msk, tsk, krm) and `st`
 * are invariant in Swedish, so there is no general pluralization rule to write.
 */
export function formatQuantity(quantity: ScaledQuantity): string {
  if (quantity.kind === "to_taste") return "efter smak";

  const amount = Number.isInteger(quantity.amount)
    ? String(quantity.amount)
    : quantity.amount.toFixed(1).replace(".", ",");
  const unit =
    quantity.amount === 1 ? quantity.unit : (PLURAL_UNIT_FORMS[quantity.unit] ?? quantity.unit);

  return `${amount} ${unit}`;
}

/**
 * Rounded to one decimal only when the total isn't whole, so a plain household
 * of adults never sees a stray ".0". portions itself stays a raw number over
 * the wire; this formatting is the frontend's alone to change.
 */
export function formatPortionsCount(portions: number): string {
  const rounded = Math.round(portions * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * "portion" only when the rounded value is exactly 1 — 1.5 and 0 both take the
 * plural (#176: MIN_PORTIONS keeps 0 from happening in practice, but the plural
 * is the safe fallback if it ever did).
 */
export function portionsNoun(portions: number): "portion" | "portioner" {
  const rounded = Math.round(portions * 10) / 10;
  return rounded === 1 ? "portion" : "portioner";
}

/** "För 4 portioner" — the guided flow's portions step (#174) renders the same
 *  three words but sizes the count on its own, since `formatPortionsCount`
 *  is what it actually wants to make large. */
export function formatPortions(portions: number): string {
  return `För ${formatPortionsCount(portions)} ${portionsNoun(portions)}`;
}
