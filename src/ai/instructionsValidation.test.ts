import { describe, expect, it } from "vitest";
import { loadEngineData } from "../engine/data.js";
import type { IngredientSlotRole } from "../schema/recipeTemplate.js";
import {
  INGREDIENT_SCAN_EXCEPTIONS,
  buildIngredientLexicon,
  findForeignIngredients,
  findModelQuantities,
  validateGeneratedInstructions,
} from "./instructionsValidation.js";

// Exercised against the real curated catalog rather than fixtures. The thing under
// test *is* the interaction between a scanner and 206 hand-verified Swedish
// ingredient names — a fixture catalog of three invented words would prove nothing
// about whether "stek på hög värme" survives contact with `högrev`.

const engineData = await loadEngineData();
const lexicon = buildIngredientLexicon(engineData.ingredientsById.values());

/** One slot per `IngredientSlotRole`, so "outside the template" can be asserted
 *  role by role rather than sampled. */
const TEMPLATE_BY_ROLE: Record<IngredientSlotRole, string> = {
  protein: "kycklingfile",
  starch: "basmatiris",
  vegetable: "broccoli",
  aromatic: "vitlok",
  dairy: "matlagningsgradde",
};

const TEMPLATE_INGREDIENTS = new Set(Object.values(TEMPLATE_BY_ROLE));

/** A catalog ingredient of the same role that the template does not contain — the
 *  exact thing a generated step must never introduce. */
const FOREIGN_BY_ROLE: Record<IngredientSlotRole, string> = {
  protein: "räkor",
  starch: "spagetti",
  vegetable: "spenat",
  aromatic: "ingefära",
  dairy: "parmesan",
};

describe("the exception list", () => {
  // Guarding the constant itself, not just its behaviour: the comment on it says it
  // must never grow, and a test is the only thing that makes that more than a wish.
  it("is exactly salt, peppar and vatten", () => {
    expect([...INGREDIENT_SCAN_EXCEPTIONS].sort()).toEqual(["peppar", "salt", "vatten"]);
  });

  // There is deliberately no test here computing the *criterion* for membership.
  // "Maps to no allergen" was computable and is gone with the allergen data (#224);
  // what replaced it — "every kitchen has it and no shopping list has to carry it" —
  // is a judgement about three specific words, not a property of a row (salt is
  // itself a catalog ingredient). Asserting the list's exact contents above is the
  // honest guard; inventing a computable stand-in would only look like one.

  it("lets a step season freely", () => {
    const steps = ["Smaka av med salt och peppar.", "Koka upp vatten i en stor kastrull."];
    expect(findForeignIngredients(lexicon, steps, TEMPLATE_INGREDIENTS)).toEqual([]);
  });
});

describe("findForeignIngredients", () => {
  it.each(Object.entries(FOREIGN_BY_ROLE))(
    "rejects a step introducing an ingredient outside the template (%s role)",
    (_role, foreignName) => {
      const steps = [`Tillsätt ${foreignName} och rör om.`];
      expect(findForeignIngredients(lexicon, steps, TEMPLATE_INGREDIENTS)).not.toEqual([]);
    },
  );

  it("accepts a step naming the template's own ingredients", () => {
    const steps = [
      "Skär kycklingfilén i bitar.",
      "Koka basmatiriset enligt anvisningen.",
      "Dela broccolin i buketter.",
      "Hacka vitlöken fint.",
      "Häll i matlagningsgrädden och låt sjuda.",
    ];
    expect(findForeignIngredients(lexicon, steps, TEMPLATE_INGREDIENTS)).toEqual([]);
  });

  it("accepts a shortened reference back to a compound ingredient", () => {
    // "kycklingen" for kycklingfilé, "riset" for basmatiris — how a step refers to
    // something it already introduced in full, and the single most common way a
    // naive scanner produces a false rejection.
    const steps = ["Bryn kycklingen på hög värme.", "Rör ner riset."];
    expect(findForeignIngredients(lexicon, steps, TEMPLATE_INGREDIENTS)).toEqual([]);
  });

  it.each([
    ["soja", new Set(["sojagroddar"])],
    ["ägg", new Set(["aggnudlar"])],
  ])(
    "now accepts '%s' on a template holding only the compound built around it",
    (shortName, templateIngredients) => {
      // Deliberately the inverse of the pre-#224 assertion, kept rather than deleted
      // because it is the one behaviour change in this module a reader needs pointed
      // at. These two pairs are exactly what the allergen-identity gate in
      // `resolveToken` bought — soja (soy sauce) carried gluten that sojagroddar did
      // not — and with allergens gone there is no data left that can tell a stem-
      // sharing compound apart from a genuine shortening. Measured over the full
      // library the gate was worth 3 catches in 33 931 foreign mentions; ingredient
      // `category` was measured as a replacement and rejected for costing 60
      // rejections of legitimate prose. See resolveToken's comment for the numbers.
      const steps = [`Tillsätt ${shortName} och rör om.`];
      expect(findForeignIngredients(lexicon, steps, templateIngredients)).toEqual([]);
    },
  );

  it("sees words separated by punctuation rather than a space", () => {
    expect(
      findForeignIngredients(lexicon, ["Blanda kycklingfilé,cashewnötter och rör om."], TEMPLATE_INGREDIENTS),
    ).not.toEqual([]);
  });

  it("leaves ordinary cooking prose alone", () => {
    const steps = [
      "Låt såsen puttra tills den tjocknar.",
      "Stek på hög värme tills det fått färg.",
      "Sätt ugnen på 200 grader.",
      "Häll av vattnet och ställ åt sidan.",
      "Skär i bitar och lägg i en ugnsform.",
      "Servera direkt medan det är varmt.",
    ];
    expect(findForeignIngredients(lexicon, steps, TEMPLATE_INGREDIENTS)).toEqual([]);
  });
});

// The `ALLERGEN_HEAD_NOUNS` describe that stood here is gone with the mechanism
// (#224). It asserted that "grädden", "osten", "nötter", "mjölet" and the rest were
// rejected on a template not already carrying that allergen — a question about
// allergens end to end, and one measurement made that plain: the rule treated
// "pastan" as covered on 94 templates holding vetemjöl, couscous or havregryn and no
// pasta at all, purely because they shared gluten. It never answered "does this
// template contain this food", so there was nothing to re-point at a surviving
// subject. Those words are now free prose, like "buljongen" and "såsen" always were —
// see the module comment on the scan's uniform fail-open limit.

describe("findModelQuantities", () => {
  it.each([
    "Tillsätt 300 g kycklingfilé.",
    "Häll i 2 dl matlagningsgrädde.",
    "Rör ner 1 msk olja.",
    "Mät upp 2 tsk salt.",
    "Strö över 1 krm kanel.",
    "Ta 3 st ägg.",
    "Pressa 2 klyftor vitlök.",
    "Använd 1 kruka färsk persilja.",
    "Väg upp 500 gram potatis.",
    "Koka 4 deciliter ris.",
    "Tillsätt 2 matskedar soja.",
  ])("rejects a model-written amount: %s", (step) => {
    expect(findModelQuantities(lexicon, [step])).not.toEqual([]);
  });

  it("rejects a bare count in front of an ingredient", () => {
    expect(findModelQuantities(lexicon, ["Hacka 2 lökar och fräs dem mjuka."])).not.toEqual([]);
  });

  it.each([
    "Stek kycklingen i 6 minuter.",
    "Grädda i ugnen på 200 grader.",
    "Låt sjuda 20 min under lock.",
    "Vila köttet 5 minuter före servering.",
    "Koka riset 12 minuter.",
    "Skär i 4 bitar.",
  ])("allows times, temperatures and non-amounts: %s", (step) => {
    expect(findModelQuantities(lexicon, [step])).toEqual([]);
  });

  it.each(["Tillsätt 300g kycklingfilé.", "Häll i 2dl grädde.", "Rör ner 1msk olja."])(
    "catches an amount written without a space: %s",
    (step) => {
      // The guard must not depend on whether the model happened to type a space.
      expect(findModelQuantities(lexicon, [step])).not.toEqual([]);
    },
  );

  it("catches an amount even for an ingredient the template does contain", () => {
    // The Meal Engine owns every number a household acts on, so "300 g kycklingfilé"
    // is a bug on the chicken template too — being in the ingredient list is not a
    // licence to state how much of it.
    expect(findModelQuantities(lexicon, ["Bryn 300 g kycklingfilé."])).not.toEqual([]);
  });
});

describe("validateGeneratedInstructions", () => {
  const clean = [
    "Sätt på pastavattnet och salta ordentligt.",
    "Skär kycklingfilén i bitar.",
    "Bryn kycklingen på hög värme tills den fått färg.",
    "Hacka vitlöken och fräs den mjuk.",
    "Dela broccolin i buketter och koka den knapriga.",
    "Häll i matlagningsgrädden och låt såsen puttra 5 minuter.",
  ];

  it("passes a clean generation", () => {
    expect(validateGeneratedInstructions(lexicon, clean, TEMPLATE_INGREDIENTS)).toEqual({ ok: true });
  });

  it("reports a foreign ingredient", () => {
    const result = validateGeneratedInstructions(
      lexicon,
      [...clean, "Toppa med rostade cashewnötter."],
      TEMPLATE_INGREDIENTS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.kind).toBe("foreign_ingredient");
  });

  it("reports a model-written amount", () => {
    const result = validateGeneratedInstructions(
      lexicon,
      [...clean, "Häll i 2 dl matlagningsgrädde."],
      TEMPLATE_INGREDIENTS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.kind).toBe("model_quantity");
  });
});

// The properties that decide whether this scanner is deployable, measured across all
// 170 curated templates rather than argued from examples. The numbers these produce
// are reported in the PR (#154, remeasured for #224); if either regresses, the scanner
// is wrong, not the test.
describe("across the whole curated template library", () => {
  const DEFINITE_SUFFIXES = ["", "en", "n", "et", "t", "arna", "orna", "erna", "ar", "or"];

  function headOf(name: string): string {
    return name.toLowerCase().split(/\s+/).pop()!;
  }

  it("never rejects a step that names the template's own ingredients", () => {
    const rejected: string[] = [];
    let checks = 0;

    for (const template of engineData.templates) {
      const allowed = new Set(template.ingredient_slots.map((slot) => slot.ingredient_id));

      for (const slot of template.ingredient_slots) {
        const ingredient = engineData.ingredientsById.get(slot.ingredient_id)!;
        const head = headOf(ingredient.name);
        const forms = new Set<string>([ingredient.name.toLowerCase(), head]);
        for (const suffix of DEFINITE_SUFFIXES) forms.add(head + suffix);

        // Legitimate shortenings too: any catalog name this ingredient's name is a
        // compound of. #224 dropped the allergen-identity condition that used to
        // qualify this set — so `soja` on a sojagroddar dish and `ägg` on an
        // äggnudlar dish are now among the forms asserted to pass, and they do.
        for (const other of engineData.ingredientsById.values()) {
          const otherHead = headOf(other.name);
          if (otherHead === head) continue;
          if (!head.startsWith(otherHead) && !head.endsWith(otherHead)) continue;
          for (const suffix of DEFINITE_SUFFIXES) forms.add(otherHead + suffix);
        }

        for (const form of forms) {
          checks++;
          const step = `Tillsätt ${form} och rör om.`;
          if (findForeignIngredients(lexicon, [step], allowed).length > 0) {
            rejected.push(`${template.id}/${ingredient.id}: "${form}"`);
          }
        }
      }
    }

    expect(checks).toBeGreaterThan(10_000);
    expect(rejected).toEqual([]);
  });

  it("catches all but a pinned handful of foreign catalog mentions", () => {
    // What replaced the old "no escape introduces a new allergen" assertion, which had
    // no subject left after #224. Some foreign mentions do slip past — an ambiguous
    // Swedish shortening resolves toward the template by design (see
    // findForeignIngredients) — and the honest thing to assert is now the *rate*,
    // pinned, so a change that made resolution sloppier shows up here.
    //
    // Measured, not guessed: dropping the allergen gate on compound expansion moved
    // this from 203 to 206 out of 33 931. Investigate a disagreement, do not adjust
    // the expected value.
    let mentions = 0;
    const escaped: string[] = [];
    const catalog = [...engineData.ingredientsById.values()];

    for (const template of engineData.templates) {
      const allowed = new Set(template.ingredient_slots.map((slot) => slot.ingredient_id));

      for (const ingredient of catalog) {
        if (allowed.has(ingredient.id)) continue;
        if (INGREDIENT_SCAN_EXCEPTIONS.has(headOf(ingredient.name))) continue;
        mentions++;

        const step = `Tillsätt ${ingredient.name.toLowerCase()} och rör om.`;
        if (findForeignIngredients(lexicon, [step], allowed).length === 0) {
          escaped.push(`${template.id} <- ${ingredient.id}`);
        }
      }
    }

    expect(mentions).toBe(33_931);
    expect(escaped.length).toBe(206);
  });
});
