import type { Allergy } from "../schema/vocabulary.js";
import type { Ingredient } from "../schema/ingredient.js";
import { QuantityUnitSchema } from "../schema/recipeTemplate.js";

// The deterministic gate between the AI Orchestrator and anything a household
// reads or the cache keeps (#154). Two independent checks, both pure and both
// running on every generated step before it is cached:
//
//   1. No step may name an ingredient the template does not contain.
//   2. No step may state an amount — amounts are curated data rendered by the
//      Meal Engine into the ingredient card, never model output.
//
// This is the allergy protection on this surface, and per CLAUDE.md it is not the
// model's responsibility: the prompt asks for the same two things, but a prompt is
// a request and this is the guarantee. On a violation the route regenerates once
// and then fails — it never "cleans up" a step, because a step that had to be
// repaired is a step whose remaining words were not written under the constraint
// either.
//
// What this deliberately does NOT do is decompose Swedish compounds. "Såsen" and
// "grädden" are head nouns, not catalog entries, and treating every shared word
// ending as an ingredient mention rejects ordinary cooking prose ("låt såsen
// puttra") at a rate that would make the surface unusable. A shortened form is
// recognised only when the short form is itself a name in the catalog — see
// `matchesName` below.

/**
 * The only words exempt from the ingredient scan. **This list must never grow.**
 *
 * Salt, pepper and water are exempt because every kitchen has them, no template
 * ingredient list is expected to justify them, and none of the three maps to an
 * allergen. That last clause is the whole rule: the moment an exemption maps to an
 * allergen, the scan stops being a safety check and becomes a formatting
 * preference. Butter and oil are the obvious next candidates and are deliberately
 * absent — milk fat is a dairy allergen and the nut oils are worse. If the scan
 * rejects too often, fix the prompt or the lexicon; adding an entry here is not an
 * available move (#154).
 */
export const INGREDIENT_SCAN_EXCEPTIONS: ReadonlySet<string> = new Set([
  "salt",
  "peppar",
  "vatten",
]);

/**
 * Curated units (`QuantityUnitSchema`) plus the ways a model spells them out. A
 * digit next to any of these is an amount, and an amount from the model is the bug
 * this catches.
 */
const QUANTITY_UNIT_TOKENS: ReadonlySet<string> = new Set([
  ...QuantityUnitSchema.options,
  "gram",
  "kilo",
  "kg",
  "hekto",
  "hg",
  "liter",
  "deciliter",
  "centiliter",
  "milliliter",
  "ml",
  "cl",
  "dl",
  "matsked",
  "matskedar",
  "tesked",
  "teskedar",
  "kryddmått",
  "krukor",
  "klyftor",
  "stycken",
  "port",
  "portion",
  "portioner",
  "nypa",
  "nypor",
]);

/**
 * Times and temperatures are the one numeric class a step may carry: they follow
 * from the template's curated `prep_time_band`, they are useless as prose without
 * a number ("stek tills den känns klar" is worse cooking advice than "stek i 6
 * minuter"), and no household plans a week around them. The *total* time on the
 * cook screen is curated and never summed from these — see DECISION_LOG.
 */
const TIME_TEMPERATURE_TOKENS: ReadonlySet<string> = new Set([
  "minut",
  "minuter",
  "minuters",
  "min",
  "sekund",
  "sekunder",
  "sek",
  "timme",
  "timmar",
  "timmes",
  "tim",
  "grad",
  "grader",
  "graders",
  "°c",
  "c",
  "varmluft",
  "steg",
]);

/**
 * Generic Swedish food words that always imply an allergen but are *not* catalog
 * names, so the ingredient scan above cannot see them.
 *
 * The catalog names products — `vispgrädde`, `fetaost`, `cashewnötter`, `vetemjöl` —
 * while a step naturally says "grädden", "osten", "nötter", "mjölet". Those words
 * resolve to nothing in the lexicon (see `matchesName`: a word that is not itself a
 * catalog entry expands to no compound), which left the single most consequential
 * class of invented ingredient invisible. This closes it.
 *
 * Deliberately narrow, and not the same thing as `INGREDIENT_SCAN_EXCEPTIONS`: this
 * list makes the scan *stricter*, so it may grow when a generic allergen-bearing
 * noun is found missing. Every entry must be a word whose allergen reading is
 * unambiguous in a recipe — which is why "nöt" is absent (Swedish "nötfärs" is
 * beef, not a nut) and only the unmistakable plural "nötter" is listed, and why
 * "nudlar" is absent (glasnudlar and risnudlar carry no gluten).
 */
const ALLERGEN_HEAD_NOUNS: ReadonlyMap<string, Allergy> = new Map<string, Allergy>([
  ["grädde", "dairy_lactose"],
  ["mjölk", "dairy_lactose"],
  ["ost", "dairy_lactose"],
  ["yoghurt", "dairy_lactose"],
  ["nötter", "tree_nuts"],
  ["mjöl", "gluten"],
  ["bröd", "gluten"],
  ["pasta", "gluten"],
  ["skaldjur", "shellfish"],
]);

/** Swedish definite/plural endings, longest first — stripped to produce candidate
 *  stems. Every candidate is tried, and the unstemmed token is always among them,
 *  so an over-eager strip ("salt" → "sal") can only add matches, never remove the
 *  correct one. */
const INFLECTION_SUFFIXES = [
  "arnas",
  "ornas",
  "ernas",
  "arna",
  "orna",
  "erna",
  "ens",
  "ets",
  "ans",
  "ar",
  "or",
  "er",
  "en",
  "et",
  "na",
  "ns",
  "n",
  "t",
  "s",
] as const;

/** Below three characters a token carries no reliable signal — and no catalog name
 *  is shorter, so nothing is lost by ignoring them. */
const MIN_TOKEN_LENGTH = 3;

export interface IngredientLexicon {
  /** Ingredient id → the single-word forms that name it: the head noun of its
   *  catalog name, plus the whole name when that name is one word. */
  readonly formsById: ReadonlyMap<string, readonly string[]>;
  /** Form → the ingredients that form names outright. A word found here is a
   *  catalog name in its own right, which is the precondition for it matching a
   *  compound built around it. */
  readonly idsByForm: ReadonlyMap<string, readonly string[]>;
  /** Ingredient id → its allergen set, order-normalised for comparison. Compound
   *  matching is gated on this — see `resolveToken`. */
  readonly allergenKeyById: ReadonlyMap<string, string>;
  /** Ingredient id → its allergens, for the head-noun check below. */
  readonly allergensById: ReadonlyMap<string, readonly string[]>;
}

function normalize(text: string): string {
  return text.toLowerCase().normalize("NFC");
}

/**
 * Words and numbers as separate tokens.
 *
 * Digits and letters always split, so "300g" is `["300", "g"]` exactly like "300 g"
 * — a guard that depended on whether the model happened to type a space would not be
 * a guard. Punctuation splits too ("kyckling,cashewnötter" is two words), except a
 * decimal separator between digits, which is part of the number. Ranges ("8-10")
 * split into two numbers, which is what we want: each is checked against what
 * follows it.
 */
function tokenize(text: string): string[] {
  const withDecimalPoints = normalize(text).replace(/(\d)[,.](\d)/g, "$1.$2");
  return [...withDecimalPoints.matchAll(/\d+(?:\.\d+)?|[a-zà-öø-ÿ°]+/gu)].map((match) => match[0]);
}

function stemCandidates(token: string): string[] {
  const candidates = [token];
  for (const suffix of INFLECTION_SUFFIXES) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      candidates.push(token.slice(0, -suffix.length));
    }
  }
  return candidates;
}

/**
 * `allergensByIngredientId` is the curated, 100%-hand-verified allergen mapping —
 * passed in rather than looked up here so this module stays pure and the caller
 * keeps owning the data (`EngineData.allergenMappingByIngredientId`). An ingredient
 * absent from it is treated as carrying no allergens, matching how the rest of the
 * engine reads that map.
 */
export function buildIngredientLexicon(
  ingredients: Iterable<Ingredient>,
  allergensByIngredientId: ReadonlyMap<string, { readonly allergens: readonly string[] }>,
): IngredientLexicon {
  const formsById = new Map<string, string[]>();
  const idsByForm = new Map<string, string[]>();
  const allergenKeyById = new Map<string, string>();
  const allergensById = new Map<string, readonly string[]>();

  for (const ingredient of ingredients) {
    const words = normalize(ingredient.name).split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    // The head noun only, never the modifiers: "gul lök" is named by "lök", and
    // registering "gul" would make a colour word read as an ingredient mention.
    const head = words[words.length - 1]!;
    const forms = words.length === 1 ? [head] : [head, words.join(" ")];

    formsById.set(ingredient.id, forms);
    for (const form of forms) {
      const existing = idsByForm.get(form);
      if (existing) existing.push(ingredient.id);
      else idsByForm.set(form, [ingredient.id]);
    }

    const allergens = [...(allergensByIngredientId.get(ingredient.id)?.allergens ?? [])].sort();
    allergenKeyById.set(ingredient.id, allergens.join("|"));
    allergensById.set(ingredient.id, allergens);
  }

  return { formsById, idsByForm, allergenKeyById, allergensById };
}

/**
 * Every catalog ingredient a single word could be naming. Empty means the word is
 * not an ingredient mention at all.
 *
 * Two passes, and the gap between them is where the safety of this whole check
 * lives.
 *
 * The first pass is exact: after stemming, the word *is* a catalog name.
 *
 * The second pass expands to compounds built around that name — "kyckling" also
 * naming `kycklingfilé`, "ris" also naming `basmatiris` — because that is how a
 * step refers back to an ingredient it introduced in full, and without it ordinary
 * prose is rejected constantly. But an expansion is admitted **only when the
 * compound carries exactly the allergens the short name does.** Sharing a word stem
 * is not the same thing as being the same food: `soja` (soy sauce — soy *and*
 * gluten) and `sojagroddar` (bean sprouts — soy) share four letters and differ by an
 * allergen, and without this gate a step saying "soja" would pass unchallenged on a
 * bean-sprout template. Measured against the full library, that gate is the
 * difference between two allergen-introducing misses and none (#154).
 *
 * A word that is not a catalog name expands to nothing, which is why "såsen" and
 * "grädden" are free prose — see the module comment.
 */
function resolveToken(token: string, lexicon: IngredientLexicon): Set<string> {
  const stems = stemCandidates(token);
  const resolved = new Set<string>();

  for (const stem of stems) {
    for (const id of lexicon.idsByForm.get(stem) ?? []) resolved.add(id);
  }
  if (resolved.size === 0) return resolved;

  for (const stem of stems) {
    const anchors = lexicon.idsByForm.get(stem);
    if (!anchors) continue;
    const anchorAllergenKeys = new Set(anchors.map((id) => lexicon.allergenKeyById.get(id) ?? ""));

    for (const [id, forms] of lexicon.formsById) {
      if (resolved.has(id)) continue;
      if (!anchorAllergenKeys.has(lexicon.allergenKeyById.get(id) ?? "")) continue;
      const isCompound = forms.some(
        (form) =>
          !form.includes(" ") &&
          form !== stem &&
          (form.startsWith(stem) || form.endsWith(stem)),
      );
      if (isCompound) resolved.add(id);
    }
  }

  return resolved;
}

/**
 * Words in `steps` that name a catalog ingredient the template does not contain.
 *
 * A word that could name several catalog ingredients (Swedish shortenings routinely
 * can — "löken" is any of five) passes as soon as *one* of them is in the template.
 * That is deliberate and it is not a hole: the model is only ever shown this
 * template's ingredients (see instructionsPrompt.ts), so an ambiguous shortening is
 * overwhelmingly a reference back to the one it was given, and resolving ambiguity
 * against the template is what keeps ordinary prose from being rejected. A word that
 * matches *no* ingredient in the template still fails, which is the case that
 * matters.
 */
export function findForeignIngredients(
  lexicon: IngredientLexicon,
  steps: readonly string[],
  allowedIngredientIds: ReadonlySet<string>,
): string[] {
  const foreign: string[] = [];

  for (const step of steps) {
    for (const token of tokenize(step)) {
      if (token.length < MIN_TOKEN_LENGTH) continue;
      if (/[0-9]/.test(token)) continue;
      if (stemCandidates(token).some((stem) => INGREDIENT_SCAN_EXCEPTIONS.has(stem))) continue;

      const candidates = resolveToken(token, lexicon);
      if (candidates.size === 0) {
        if (namesUncoveredAllergen(token, lexicon, allowedIngredientIds)) foreign.push(token);
        continue;
      }

      let allowed = false;
      for (const candidate of candidates) {
        if (allowedIngredientIds.has(candidate)) {
          allowed = true;
          break;
        }
      }
      if (!allowed) foreign.push(token);
    }
  }

  return foreign;
}

/**
 * Whether a generic food word puts an allergen on the screen that the template does
 * not already carry.
 *
 * Two ways to be in the clear, and both are about the word plausibly referring to
 * something the model was actually given. Either the template holds an ingredient
 * carrying that allergen ("osten" on a parmesan dish), or it holds an ingredient
 * whose name ends in the word itself ("mjölet" on a potatismjöl dish — gluten-free,
 * but unmistakably what the step means). Otherwise the model has introduced dairy,
 * gluten, nuts or shellfish out of nowhere, and that is the case this exists for.
 */
function namesUncoveredAllergen(
  token: string,
  lexicon: IngredientLexicon,
  allowedIngredientIds: ReadonlySet<string>,
): boolean {
  for (const stem of stemCandidates(token)) {
    const allergen = ALLERGEN_HEAD_NOUNS.get(stem);
    if (!allergen) continue;

    let covered = false;
    for (const ingredientId of allowedIngredientIds) {
      if (lexicon.allergensById.get(ingredientId)?.includes(allergen)) {
        covered = true;
        break;
      }
      const forms = lexicon.formsById.get(ingredientId) ?? [];
      if (forms.some((form) => !form.includes(" ") && form.endsWith(stem))) {
        covered = true;
        break;
      }
    }
    if (!covered) return true;
  }

  return false;
}

function isNumber(token: string): boolean {
  return /^[0-9]+([,.][0-9]+)?$/.test(token);
}

/**
 * Numeric amounts surviving in `steps` — the check that keeps the Meal Engine the
 * only source of a quantity.
 *
 * A number is an amount when the next word or two is a unit ("2 dl"), or an
 * ingredient ("2 lökar"). A number followed by a time, a temperature or an ordinary
 * noun ("skär i 4 bitar") is not an amount and passes. `lexicon` is consulted for
 * *any* catalog ingredient, template membership irrelevant: "300 g kycklingfilé" is
 * a bug even on the chicken template.
 */
export function findModelQuantities(
  lexicon: IngredientLexicon,
  steps: readonly string[],
): string[] {
  const quantities: string[] = [];

  for (const step of steps) {
    const tokens = tokenize(step);
    for (const [index, token] of tokens.entries()) {
      if (!isNumber(token)) continue;

      const following = tokens.slice(index + 1, index + 3);
      // A time or temperature anywhere in the lookahead settles it — "200 grader"
      // must not be re-read as an amount because some later word looks like a unit.
      if (following.some((next) => TIME_TEMPERATURE_TOKENS.has(next))) continue;

      const offending = following.find(
        (next) =>
          QUANTITY_UNIT_TOKENS.has(next) ||
          (next.length >= MIN_TOKEN_LENGTH &&
            !/[0-9]/.test(next) &&
            resolveToken(next, lexicon).size > 0),
      );
      if (offending) quantities.push(`${token} ${offending}`);
    }
  }

  return quantities;
}

export type InstructionsRejection =
  | { kind: "foreign_ingredient"; mentions: string[] }
  | { kind: "model_quantity"; mentions: string[] };

export type InstructionsValidation = { ok: true } | { ok: false; rejection: InstructionsRejection };

/**
 * Both checks, in the order their failures matter. Called by the instructions route
 * between generation and the cache write, so an invalid result is never stored and
 * never seen.
 */
export function validateGeneratedInstructions(
  lexicon: IngredientLexicon,
  steps: readonly string[],
  allowedIngredientIds: ReadonlySet<string>,
): InstructionsValidation {
  const foreign = findForeignIngredients(lexicon, steps, allowedIngredientIds);
  if (foreign.length > 0) {
    return { ok: false, rejection: { kind: "foreign_ingredient", mentions: foreign } };
  }

  const quantities = findModelQuantities(lexicon, steps);
  if (quantities.length > 0) {
    return { ok: false, rejection: { kind: "model_quantity", mentions: quantities } };
  }

  return { ok: true };
}
