import { z } from "zod";
import { SlugIdSchema } from "./ingredient.js";

// ARCHITECTURE.md §5.5 / #223 — the record for a variety family.
//
// #221 put `variety_of` on the ingredient and answered *membership*: which family an
// ingredient belongs to is a property of the ingredient, because every ingredient is
// a variety of exactly one product. That answer is unchanged and the field stays
// where it is. This file answers a different question #221 never had to: where the
// *family* lives once it has to carry curated text of its own. Until now it lived
// nowhere — a family was a string repeated on its members, with nothing to attach to.
//
// Making the file the owner of the namespace is the point, not a side effect. A note
// keyed by an open namespace fails silently: "no note" is a legitimate state for most
// families, so a typo in the key is indistinguishable from a family that was never
// meant to say anything. With the file, the same typo is a referential-integrity
// error. That trade is why this is a record and not a lookup table of prose.
export const VarietyFamilySchema = z.object({
  // The `variety_of` key its members carry. Its own namespace still — never an
  // ingredient id and never a substitution-group id (#221) — but no longer an open
  // one: `validate` requires every `variety_of` to resolve here.
  id: SlugIdSchema,
  // The everyday Swedish product name ("Grädde", "Mjukt bröd"). Not shown anywhere
  // yet; it exists so a row is readable as curated data on its own, the way a
  // substitution group carries a `name` it does not strictly need either.
  name: z.string().min(1),
  /**
   * One curated sentence, shown when pantry coverage bridged two varieties — the
   * household marked vispgrädde and the dish asks for matlagningsgrädde (#223).
   *
   * Optional and normally absent: authored only where the difference changes what
   * you do or what comes out of the pan, not wherever two varieties merely differ.
   * A family with no note is the normal case and is never flagged.
   *
   * Hand-written prose, never generated and never templated from data. It carries no
   * number a household would act on — no fat percentages, no prices, no times, and
   * above all no re-scaled amount. The engine holds no fat content, density or
   * cooking property to compute one from, and a model must not invent one (CLAUDE.md
   * non-negotiable, the same rule that governs cost figures). "It will come out
   * different, and here is how" is the whole promise; "use 1.5 dl instead of 2" is
   * the promise this deliberately does not make.
   */
  note: z.string().min(1).optional(),
});
export type VarietyFamily = z.infer<typeof VarietyFamilySchema>;
