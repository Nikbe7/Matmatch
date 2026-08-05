import { z } from "zod";

// CLAUDE.md's non-negotiable is "never let AI invent numbers a user will trust" for
// cost and nutrition — it is not a ban on numbers in general. Oven temperatures,
// minute counts and other cooking parameters that follow from the template's own
// prep_time_band are expected and useful ("stek i 6 minuter", "in i ugnen på 200
// grader"). Do NOT widen this guard to strip all digits — that produces unusable
// instructions for every gratäng, ugnsbakad or timed dish. The only thing this
// rejects is a currency/price figure, which is curated cost-tier data's job
// (ARCHITECTURE.md §4.2), never the model's.
const CURRENCY_PATTERN = /\d+\s*kr\b|\bkr\b|\bkronor\b|\bsek\b/i;

const StepSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((step) => !CURRENCY_PATTERN.test(step), {
    message: "a cooking step must not mention a price or currency figure",
  });

/**
 * Shape of a Tier 1 instruction-generation response, per issue #78: 6-10 short
 * Swedish steps, nothing else — no ingredient re-listing, no serving suggestions, no
 * nutrition, no tips section. Enforced by prompt instruction *and* this schema, since
 * the prompt alone is not a guarantee.
 */
export const GeneratedInstructionsSchema = z.object({
  steps: z.array(StepSchema).min(6).max(10),
});

export type GeneratedInstructions = z.infer<typeof GeneratedInstructionsSchema>;
