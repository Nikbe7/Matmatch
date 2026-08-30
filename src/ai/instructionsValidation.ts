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
// Per CLAUDE.md neither check is the model's responsibility: the prompt asks for the
// same two things, but a prompt is a request and this is the guarantee. On a
// violation the route regenerates once and then fails — it never "cleans up" a step,
// because a step that had to be repaired is a step whose remaining words were not
// written under the constraint either.
//
// What this is, exactly: a consistency check between generated prose and the curated
// ingredient list rendered beside it. A step that names a food the card does not list
// is a step a household cannot cook from. That is the whole claim, and since #224 it
// is the only one — this file no longer sits on an allergy path, no longer knows what
// an allergen is, and a pass here has never been and must never be read as evidence
// that a meal is safe for anyone.
//
// The check is fail-open for any word that is not itself a catalog name, and that is
// a deliberate, uniform trade rather than a narrow gap: "såsen", "grädden" and
// "buljongen" are head nouns, not catalog entries, and treating every shared word
// ending as an ingredient mention rejects ordinary cooking prose ("låt såsen puttra")
// at a rate that would make the surface unusable. A shortened form is recognised only
// when the short form is itself a name in the catalog — see `resolveToken`.

/**
 * The only words exempt from the ingredient scan. **This list must never grow.**
 *
 * Salt, pepper and water are exempt because every kitchen already has them and no
 * template ingredient list is expected to justify them — they are the only three
 * foods a step may name that a household never has to be told to buy. That is the
 * whole rule, and it is what keeps the list closed: butter and oil are the obvious
 * next candidates and are deliberately absent, because both are catalog ingredients
 * with their own cost tier that belong on a shopping list. Exempting them would let
 * a step call for something the household was never asked to have. If the scan
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
 * Built once per process from the ingredient catalog and nothing else — the module
 * stays pure and the caller keeps owning the data (`EngineData.ingredientsById`).
 */
export function buildIngredientLexicon(ingredients: Iterable<Ingredient>): IngredientLexicon {
  const formsById = new Map<string, string[]>();
  const idsByForm = new Map<string, string[]>();

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
  }

  return { formsById, idsByForm };
}

/**
 * Every catalog ingredient a single word could be naming. Empty means the word is
 * not an ingredient mention at all.
 *
 * Two passes. The first is exact: after stemming, the word *is* a catalog name. The
 * second expands to compounds built around that name — "kyckling" also naming
 * `kycklingfilé`, "ris" also naming `basmatiris` — because that is how a step refers
 * back to an ingredient it introduced in full, and without it ordinary prose is
 * rejected constantly.
 *
 * The expansion is unconditional, and that is a #224 change worth knowing about. It
 * used to be gated on the compound carrying exactly the allergens the short name did,
 * so that `soja` (soy sauce) could not pass on a `sojagroddar` (bean sprout)
 * template. The gate's justification was never precision — it also admitted
 * `ris`→`sparris` and `mango`→`mangold`, which are not the same food at all — it was
 * that it never erred in the one direction that mattered while an allergen could
 * reach an allergic household. With allergens gone there is no such direction, and
 * measured over the full library the gate was worth 3 catches in 33 931 foreign
 * mentions (203 escapes with it, 206 without) at the price of rejecting every
 * legitimate `soja`/`ägg` self-reference. Ingredient `category` was measured as a
 * replacement and rejected: it costs 60 new rejections of legitimate prose
 * ("tomaten" on a tomatpuré dish, "curryn" on a currypasta dish) to buy back 45
 * escapes, which is the wrong trade now that a miss is an inconsistency and a
 * rejection is a cook screen that fails to load.
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
    if (!lexicon.idsByForm.has(stem)) continue;

    for (const [id, forms] of lexicon.formsById) {
      if (resolved.has(id)) continue;
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
      if (candidates.size === 0) continue;

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
