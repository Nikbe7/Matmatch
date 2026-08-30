import { z } from "zod";
import { DietaryFlagSchema } from "./allergyDietary.js";

// ARCHITECTURE.md §5 — Household / HouseholdMember
//
// Dietary flags belong to the *member*, not to the household — the household's
// effective set is derived on demand (src/engine/constraints.ts's mealConstraints),
// never stored. Allergies used to live here on the same footing and are gone with the
// rest of allergy filtering (#224); the per-member shape survives them because a
// vegan and an omnivore in one home is still two different answers.
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
    // A blank name falls back exactly like a missing one. A stored household never
    // holds `""` (the client strips it before sending), but a form being edited does.
    const name = member.name?.trim();
    return name ? name : `${TYPE_LABELS[member.type]} ${ordinal}`;
  });
}
