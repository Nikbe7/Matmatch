import { z } from "zod";
import { ALLERGIES, DIETARY_FLAGS, type Allergy, type DietaryFlag } from "./vocabulary.js";

// ARCHITECTURE.md §5.2 — Allergy & dietary vocabulary
//
// The locked values live in ./vocabulary.ts (zod-free — see that file for why);
// this module only adds zod validation on top for backend/API use.

export { ALLERGIES, DIETARY_FLAGS };
export type { Allergy, DietaryFlag };

export const AllergySchema = z.enum(ALLERGIES);
export const DietaryFlagSchema = z.enum(DIETARY_FLAGS);
