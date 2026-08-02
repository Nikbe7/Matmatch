import { z } from "zod";
import { AllergySchema, DietaryFlagSchema } from "./allergyDietary.js";

// ARCHITECTURE.md §5 — Household / HouseholdMember
//
// In-memory only for now: the Meal Engine takes a household profile as input,
// nothing persists it yet. Hosting/DB provider is still an open decision
// (DECISION_LOG 2026-07-28), so this deliberately carries no id, owner or
// household_id field — those belong to the persistence slice that makes that
// call, not to the filtering slice that only needs composition and restrictions.

export const HouseholdMemberTypeSchema = z.enum(["adult", "child"]);
export type HouseholdMemberType = z.infer<typeof HouseholdMemberTypeSchema>;

export const HouseholdMemberSchema = z.object({
  type: HouseholdMemberTypeSchema,
  // Multiplier against one adult portion — a child is typically < 1. Portion math
  // itself is a later slice; this slice only carries the value.
  portion_factor: z.number().positive(),
});
export type HouseholdMember = z.infer<typeof HouseholdMemberSchema>;

export const HouseholdSchema = z.object({
  members: z.array(HouseholdMemberSchema).min(1),
  // Hard filter, safety-critical (§4.3). Reuses the locked §5.2 vocabulary —
  // never a parallel list.
  allergies: z
    .array(AllergySchema)
    .refine((allergies) => new Set(allergies).size === allergies.length, {
      message: "allergies must not contain duplicate values",
    }),
  dietary_flags: z
    .array(DietaryFlagSchema)
    .refine((flags) => new Set(flags).size === flags.length, {
      message: "dietary_flags must not contain duplicate values",
    }),
});
export type Household = z.infer<typeof HouseholdSchema>;
