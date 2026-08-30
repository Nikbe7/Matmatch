import { z } from "zod";
import { SlugIdSchema } from "./ingredient.js";
import { IngredientSlotRoleSchema } from "./recipeTemplate.js";

// ARCHITECTURE.md §5.5 — Substitution groups

// A group is an unordered set of ingredients that are interchangeable in a slot
// of the group's role. Deliberately carries no dietary field: whether a member fits
// a household is Meal Engine logic, never a property of this data. The only thing
// checked about a member at swap time is that the catalog knows it — a group may
// legitimately name an id the catalog lacks (§5.5, `isIngredientUnknown`).
export const SubstitutionGroupSchema = z.object({
  id: SlugIdSchema,
  // Swedish display text — surfaces in the UI as a swap label ("Lök"), so it is
  // human-readable prose, not a code identifier.
  name: z.string().min(1),
  role: IngredientSlotRoleSchema,
  member_ingredient_ids: z
    .array(SlugIdSchema)
    .min(2, { message: "a substitution group must have at least 2 members" })
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "member_ingredient_ids must not contain duplicate values",
    }),
});
export type SubstitutionGroup = z.infer<typeof SubstitutionGroupSchema>;
