import { z } from "zod";
import { AllergySchema, DietaryFlagSchema } from "./allergyDietary.js";

// ARCHITECTURE.md §5 — Household / HouseholdMember
//
// Allergies and dietary flags belong to the *member*, not to the household. This
// reverses the original §5 line ("shared across the household, not per-member") —
// see DECISION_LOG 2026-08-09. A household does not have allergies; people do, and
// storing only the union throws away the one fact every downstream question needs:
// whose allergy it is. The household's effective constraint set is derived on demand
// (src/engine/constraints.ts's mealConstraints), never stored, so there is exactly
// one source of truth for safety-critical data.
//
// Still in-memory only: this type deliberately carries no id, owner or household_id
// field — those belong to src/db/households.ts, so the Meal Engine keeps taking a
// plain household profile rather than a database row. That is also why a member has
// no persisted identity here: a member *is* its position in `members[]`, which is the
// handle the diner-selection control uses (#112).

export const HouseholdMemberTypeSchema = z.enum(["adult", "child"]);
export type HouseholdMemberType = z.infer<typeof HouseholdMemberTypeSchema>;

/** Longest member name accepted. A first name or nickname, not a full legal name. */
export const MEMBER_NAME_MAX_LENGTH = 40;

function noDuplicates<T>(values: T[]): boolean {
  return new Set(values).size === values.length;
}

export const HouseholdMemberSchema = z.object({
  type: HouseholdMemberTypeSchema,
  // Optional by design, and blank is a supported answer: the diner-selection control
  // (#112) falls back to a derived "Vuxen 1"/"Barn 2" label when this is empty, so a
  // household never has to name anyone to use the product. Trimmed on parse, and an
  // empty string normalises to undefined so "" and absent cannot mean different
  // things downstream.
  name: z
    .string()
    .trim()
    .max(MEMBER_NAME_MAX_LENGTH)
    .transform((value) => (value === "" ? undefined : value))
    .optional(),
  // Multiplier against one adult portion — a child is typically < 1.
  portion_factor: z.number().positive(),
  // Hard filter, safety-critical (§4.3). Reuses the locked §5.2 vocabulary — never a
  // parallel list.
  //
  // Required with no default, deliberately: the same reasoning §5.4 applies to
  // `verification_status`, one level down. An unset safety value must be structurally
  // impossible to mistake for a positively-declared empty one, so a caller that omits
  // this fails loudly rather than being handed a permissive `[]`.
  allergies: z.array(AllergySchema).refine(noDuplicates, {
    message: "allergies must not contain duplicate values",
  }),
  dietary_flags: z.array(DietaryFlagSchema).refine(noDuplicates, {
    message: "dietary_flags must not contain duplicate values",
  }),
});
export type HouseholdMember = z.infer<typeof HouseholdMemberSchema>;

export const HouseholdSchema = z.object({
  members: z.array(HouseholdMemberSchema).min(1),
});
export type Household = z.infer<typeof HouseholdSchema>;

const TYPE_LABELS: Readonly<Record<HouseholdMemberType, string>> = {
  adult: "Vuxen",
  child: "Barn",
};

/**
 * How a member is named in the UI: their own name where they have one, otherwise a
 * derived "Vuxen 1" / "Barn 2" label numbered within their own type.
 *
 * Lives here rather than in web/ because it is a property of the profile shape — the
 * numbering depends on the whole member list, so it cannot be computed from a single
 * member and must not be re-derived per surface.
 */
export function memberLabels(members: readonly HouseholdMember[]): string[] {
  const seenByType = new Map<HouseholdMemberType, number>();

  return members.map((member) => {
    const ordinal = (seenByType.get(member.type) ?? 0) + 1;
    seenByType.set(member.type, ordinal);
    return member.name ?? `${TYPE_LABELS[member.type]} ${ordinal}`;
  });
}
