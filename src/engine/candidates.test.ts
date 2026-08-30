import { describe, expect, it } from "vitest";
import {
  classifyCostTier,
  evaluateTemplateAgainstConstraints,
  roleSubstitutionPool,
  selectCandidateTemplates,
  substituteCandidateIds,
} from "./candidates.js";
import { mealDiners, type MealConstraints } from "./constraints.js";
import type { HouseholdMember } from "../schema/household.js";
import type { DietaryFlag } from "../schema/allergyDietary.js";
import { loadEngineData } from "./data.js";
import { makeEngineData, makeIngredient, makeSlot, makeTemplate } from "./__fixtures__/engineData.js";
import { makeConstraints as household } from "./__fixtures__/household.js";

// The dietary flags that actually filter (candidates.ts's HARD_DIETARY_FLAGS).
// `high_protein_preference` is a ranking preference and is asserted below to change
// nothing here — it is deliberately not in this list.
const HARD_DIETARY_FLAGS: readonly DietaryFlag[] = ["vegetarian", "vegan"];

describe("selectCandidateTemplates — dietary flags", () => {
  const data = makeEngineData({
    ingredients: [makeIngredient("morot")],
    templates: [
      makeTemplate("kott", { dietary_tags: [] }),
      makeTemplate("veg", { dietary_tags: ["vegetarian"] }),
      makeTemplate("vegansk", { dietary_tags: ["vegetarian", "vegan"] }),
      makeTemplate("protein", { dietary_tags: ["high_protein_preference"] }),
    ].map((template) => ({
      ...template,
      ingredient_slots: [makeSlot({ role: "vegetable", ingredient_id: "morot", substitutable: true })],
    })),
  });

  const idsFor = (h: MealConstraints) =>
    selectCandidateTemplates(data, h).map((candidate) => candidate.template.id);

  it("hard-filters vegetarian on the template's dietary_tags", () => {
    expect(idsFor(household({ dietary_flags: ["vegetarian"] }))).toEqual(["veg", "vegansk"]);
  });

  it("hard-filters vegan on the template's dietary_tags", () => {
    expect(idsFor(household({ dietary_flags: ["vegan"] }))).toEqual(["vegansk"]);
  });

  it("ignores high_protein_preference — it is a ranking preference, not a filter", () => {
    expect(idsFor(household({ dietary_flags: ["high_protein_preference"] }))).toEqual([
      "kott",
      "veg",
      "vegansk",
      "protein",
    ]);
  });

  it("applies vegetarian and vegan together as a conjunction", () => {
    expect(idsFor(household({ dietary_flags: ["vegetarian", "vegan"] }))).toEqual(["vegansk"]);
  });
});

describe("selectCandidateTemplates — the catalog must be able to resolve every slot", () => {
  // The gate's surviving fail-closed condition (#224). Never an allergy rule: it says
  // the engine cannot serve what it cannot describe, and without it a template naming
  // a missing id becomes a candidate and throws downstream in tonightIngredients.ts,
  // where the response is assembled — a 500 in place of a dish quietly withheld.
  const ingredients = [makeIngredient("kyckling", { category: "protein" })];

  it("excludes a template whose slot ingredient is absent from the catalog", () => {
    const data = makeEngineData({
      ingredients,
      templates: [
        makeTemplate("gryta", {
          ingredient_slots: [makeSlot({ role: "protein", ingredient_id: "finns-inte", substitutable: false })],
        }),
      ],
    });

    expect(selectCandidateTemplates(data, household())).toEqual([]);
  });

  it("excludes it regardless of who is eating — no constraint set makes an unknown id servable", () => {
    const data = makeEngineData({
      ingredients,
      templates: [
        makeTemplate("gryta", {
          dietary_tags: ["vegetarian", "vegan"],
          ingredient_slots: [makeSlot({ role: "protein", ingredient_id: "finns-inte", substitutable: true })],
        }),
      ],
    });

    for (const flags of [[], ["vegetarian"], ["vegan"], ["high_protein_preference"]] as const) {
      expect(selectCandidateTemplates(data, household({ dietary_flags: flags }))).toEqual([]);
    }
  });

  it("does not mutate the loaded template", () => {
    const template = makeTemplate("gryta", {
      ingredient_slots: [makeSlot({ role: "protein", ingredient_id: "kyckling", substitutable: true })],
    });
    const snapshot = structuredClone(template);
    const data = makeEngineData({ ingredients, templates: [template] });

    selectCandidateTemplates(data, household());

    expect(template).toEqual(snapshot);
  });
});

describe("selectCandidateTemplates — meal_types hard filter (#68)", () => {
  const data = makeEngineData({
    ingredients: [makeIngredient("morot")],
    templates: [
      makeTemplate("bara-frukost", { meal_types: ["breakfast"] }),
      makeTemplate("bara-lunch", { meal_types: ["lunch"] }),
      makeTemplate("lunch-och-middag", { meal_types: ["lunch", "dinner"] }),
      makeTemplate("bara-middag", { meal_types: ["dinner"] }),
    ].map((template) => ({
      ...template,
      ingredient_slots: [makeSlot({ role: "vegetable", ingredient_id: "morot", substitutable: true })],
    })),
  });

  it("excludes any template whose meal_types does not include dinner, even though it is otherwise servable", () => {
    const ids = selectCandidateTemplates(data, household()).map((candidate) => candidate.template.id);
    expect(ids).toEqual(["lunch-och-middag", "bara-middag"]);
  });
});

// --- Real-data assertions ------------------------------------------------------
// Everything below runs against data/*.json, the artifact the Phase 0 exit review
// (#21) measured.

const data = await loadEngineData();

/** Every ingredient a household actually ends up eating. */
function effectiveIngredientIds(h: MealConstraints): Set<string> {
  const ids = new Set<string>();
  for (const candidate of selectCandidateTemplates(data, h)) {
    for (const slot of candidate.template.ingredient_slots) ids.add(slot.ingredient_id);
  }
  return ids;
}

describe("selectCandidateTemplates over the real catalog", () => {
  it("every ingredient referenced by a surviving template resolves in the catalog", () => {
    for (const ingredientId of effectiveIngredientIds(household())) {
      expect(data.ingredientsById.has(ingredientId)).toBe(true);
    }
  });
});

describe("selectCandidateTemplates — diner-scoped constraints over the real catalog (#112)", () => {
  // Exhaustive over the flags that filter: deselecting the member carrying one must
  // stop it excluding dishes, and selecting them must still exclude every dish that
  // lacks the tag.
  //
  // Two members, only the first restricted, so "who is eating" is the only variable.
  function roster(flag: DietaryFlag): HouseholdMember[] {
    return [
      { type: "adult", portion_factor: 1, dietary_flags: [flag] },
      { type: "adult", portion_factor: 1, dietary_flags: [] },
    ];
  }

  /** What a household with nothing declared sees — the ceiling every subset works under. */
  const unrestricted = selectCandidateTemplates(data, household());

  it.each(HARD_DIETARY_FLAGS)(
    "deselecting the member who is %s stops their flag excluding dishes",
    (flag) => {
      const withoutCarrier = mealDiners(roster(flag), new Set([1]));

      expect(withoutCarrier.constraints.dietary_flags).toEqual([]);
      // Not merely "more dishes": exactly the set an unrestricted household sees.
      expect(selectCandidateTemplates(data, withoutCarrier.constraints).map((c) => c.template.id))
        .toEqual(unrestricted.map((c) => c.template.id));
    },
  );

  it.each(HARD_DIETARY_FLAGS)(
    "keeping the member who is %s still excludes every dish not tagged for it",
    (flag) => {
      const withCarrier = mealDiners(roster(flag), new Set([0, 1]));

      const offenders = selectCandidateTemplates(data, withCarrier.constraints).filter(
        (candidate) => !candidate.template.dietary_tags.includes(flag),
      );

      expect(offenders).toEqual([]);
    },
  );

  it.each(HARD_DIETARY_FLAGS)(
    "a fail-closed diner set is filtered exactly as the full household is (%s)",
    (flag) => {
      const members = roster(flag);
      const strict = selectCandidateTemplates(data, mealDiners(members).constraints).map(
        (c) => c.template.id,
      );

      // Absent, empty and out-of-range must each land on the *restricted* set — the
      // failure that matters is a bad diner parameter quietly widening what is served.
      for (const selection of [undefined, new Set<number>(), new Set([2]), new Set([1, 9])]) {
        expect(
          selectCandidateTemplates(data, mealDiners(members, selection).constraints).map(
            (c) => c.template.id,
          ),
        ).toEqual(strict);
      }
    },
  );

  it("the deselected-carrier case is a real widening, not a no-op sweep", () => {
    // Guards the sweep above from passing vacuously if the catalog ever stopped
    // containing dishes a flag excludes: every hard flag must genuinely change the
    // candidate set, or the "stops excluding dishes" assertion proves nothing.
    const widened = HARD_DIETARY_FLAGS.filter((flag) => {
      const members = roster(flag);
      return (
        selectCandidateTemplates(data, mealDiners(members).constraints).length <
        selectCandidateTemplates(data, mealDiners(members, new Set([1])).constraints).length
      );
    });

    expect(widened).toEqual([...HARD_DIETARY_FLAGS]);
  });
});

describe("selectCandidateTemplates — survival counts", () => {
  // Regression pins over the real catalog. A disagreement here means either the
  // catalog or this engine changed — investigate, do not adjust the expected value.
  //
  // The unrestricted count is the Phase 0 exit review's measured number
  // (DECISION_LOG 2026-08-02), as adjusted by #68's meal_types hard filter and the
  // two later data corrections that removed "dinner" from eight templates.
  //
  // The dietary counts are *not* from that review: #224 removed every allergy pin it
  // recorded, and these were measured against the catalog afterwards. They pin what
  // the surviving filter does, which is now the only thing that can shrink this set.
  const countFor = (h: MealConstraints) => selectCandidateTemplates(data, h).length;

  it("a household with no dietary flags sees all 148 dinner-eligible templates", () => {
    expect(countFor(household())).toBe(148);
  });

  it("vegetarian leaves 48 templates", () => {
    expect(countFor(household({ dietary_flags: ["vegetarian"] }))).toBe(48);
  });

  it("vegan leaves 26 templates", () => {
    expect(countFor(household({ dietary_flags: ["vegan"] }))).toBe(26);
  });

  it("high_protein_preference alone shrinks nothing", () => {
    expect(countFor(household({ dietary_flags: ["high_protein_preference"] }))).toBe(148);
  });

  it("no candidate carries a substitution — the engine stopped generating them (#224)", () => {
    // `substitutions` survives on CandidateTemplate for the swap popover's applied
    // swaps, which travel the same field. Nothing on this path fills it any more, and
    // a candidate that arrived carrying one would mean the rescue loop came back.
    for (const flags of [[], ["vegetarian"], ["vegan"]] as const) {
      const carrying = selectCandidateTemplates(data, household({ dietary_flags: flags })).filter(
        (candidate) => candidate.substitutions.length > 0,
      );
      expect(carrying).toEqual([]);
    }
  });
});

// #124: the ingredient-swap popover's traversal.
describe("substituteCandidateIds", () => {
  const ingredients = [
    makeIngredient("gul-lok"),
    makeIngredient("rodlok"),
    makeIngredient("purjolok"),
    makeIngredient("vitlok", { category: "spice_aromatic" }),
  ];
  const group = {
    id: "lok",
    name: "Lök",
    role: "aromatic" as const,
    member_ingredient_ids: ["gul-lok", "rodlok", "purjolok"],
  };

  it("returns every other member of a role-matching group containing the current ingredient", () => {
    const data = makeEngineData({ ingredients, substitutionGroups: [group] });

    expect(substituteCandidateIds(data, "swedish_nordic", "aromatic", "gul-lok")).toEqual(["rodlok", "purjolok"]);
  });

  it("never includes the current ingredient itself", () => {
    const data = makeEngineData({ ingredients, substitutionGroups: [group] });

    expect(substituteCandidateIds(data, "swedish_nordic", "aromatic", "gul-lok")).not.toContain("gul-lok");
  });

  it("skips a group member the catalog cannot resolve", () => {
    // The path DECISION_LOG 2026-08-25 keeps `isIngredientUnknown` for: a curated
    // group can name an id the catalog does not have, and an unresolvable id must
    // never be offered as a swap — there is no name to show for it.
    const data = makeEngineData({
      ingredients,
      substitutionGroups: [
        { ...group, member_ingredient_ids: ["gul-lok", "finns-inte", "purjolok"] },
      ],
    });

    expect(substituteCandidateIds(data, "swedish_nordic", "aromatic", "gul-lok")).toEqual(["purjolok"]);
  });

  it("ignores a group whose role does not match", () => {
    const data = makeEngineData({
      ingredients,
      substitutionGroups: [{ ...group, role: "vegetable" as const }],
    });

    expect(substituteCandidateIds(data, "swedish_nordic", "aromatic", "gul-lok")).toEqual([]);
  });

  it("de-duplicates a candidate reachable through more than one matching group", () => {
    const data = makeEngineData({
      ingredients,
      substitutionGroups: [
        group,
        { id: "lok-2", name: "Lök 2", role: "aromatic" as const, member_ingredient_ids: ["gul-lok", "rodlok"] },
      ],
    });

    expect(substituteCandidateIds(data, "swedish_nordic", "aromatic", "gul-lok")).toEqual(["rodlok", "purjolok"]);
  });

  // #222: the cuisine gate, layered on top of the role filter rather than replacing
  // it. `cuisines` is absent on almost every ingredient and means "belongs anywhere".
  describe("cuisine gate", () => {
    const bound = [
      makeIngredient("gul-lok"),
      makeIngredient("rodlok"),
      makeIngredient("purjolok", { cuisines: ["asian"] }),
    ];

    it("drops a candidate whose curated cuisines exclude the dish's", () => {
      const data = makeEngineData({ ingredients: bound, substitutionGroups: [group] });

      expect(substituteCandidateIds(data, "swedish_nordic", "aromatic", "gul-lok")).toEqual(["rodlok"]);
    });

    it("keeps that same candidate in a dish of a cuisine its list names", () => {
      const data = makeEngineData({ ingredients: bound, substitutionGroups: [group] });

      expect(substituteCandidateIds(data, "asian", "aromatic", "gul-lok")).toEqual(["rodlok", "purjolok"]);
    });

    it("keeps every candidate that carries no cuisines list at all", () => {
      const data = makeEngineData({ ingredients, substitutionGroups: [group] });

      expect(substituteCandidateIds(data, "mexican_texmex", "aromatic", "gul-lok")).toEqual([
        "rodlok",
        "purjolok",
      ]);
    });

    it("gates the candidates, never the current ingredient", () => {
      // purjolök is asian-bound and is what the (swedish) dish currently has in the
      // slot. Alternatives to it are still offered — the gate asks whether the
      // *replacement* belongs in the dish, not whether what is already there does.
      const data = makeEngineData({ ingredients: bound, substitutionGroups: [group] });

      expect(substituteCandidateIds(data, "swedish_nordic", "aromatic", "purjolok")).toEqual([
        "gul-lok",
        "rodlok",
      ]);
    });

    it("still applies the role filter — cuisine is layered on top of it, not instead of it", () => {
      const data = makeEngineData({
        ingredients: bound,
        substitutionGroups: [{ ...group, role: "vegetable" as const }],
      });

      expect(substituteCandidateIds(data, "asian", "aromatic", "gul-lok")).toEqual([]);
    });
  });

  it("traverses from the given current ingredient, not from any slot's authored one", () => {
    // rodlok is currently in the slot (e.g. after a prior swap); alternatives are
    // relative to rodlok, so gul-lok — not rodlok — must be offered back.
    const data = makeEngineData({ ingredients, substitutionGroups: [group] });

    expect(substituteCandidateIds(data, "swedish_nordic", "aromatic", "rodlok")).toEqual(["gul-lok", "purjolok"]);
  });
});

describe("roleSubstitutionPool", () => {
  const ingredients = [
    makeIngredient("gul-lok"),
    makeIngredient("rodlok"),
    makeIngredient("citron", { category: "fruit" }),
    makeIngredient("lime", { category: "fruit" }),
  ];
  const groups = [
    { id: "lok", name: "Lök", role: "aromatic" as const, member_ingredient_ids: ["gul-lok", "rodlok"] },
    { id: "citrus", name: "Citrus", role: "aromatic" as const, member_ingredient_ids: ["citron", "lime"] },
  ];

  it("unions every role-matching group, not just groups containing the excluded ingredient", () => {
    const data = makeEngineData({ ingredients, substitutionGroups: groups });

    expect(roleSubstitutionPool(data, "aromatic", "gul-lok")).toEqual(["rodlok", "citron", "lime"]);
  });

  it("excludes the given ingredient id even from a group it is not itself a member of", () => {
    const data = makeEngineData({ ingredients, substitutionGroups: groups });

    expect(roleSubstitutionPool(data, "aromatic", "citron")).not.toContain("citron");
  });

  it("skips a group member the catalog cannot resolve", () => {
    const data = makeEngineData({
      ingredients,
      substitutionGroups: [
        groups[0]!,
        { ...groups[1]!, member_ingredient_ids: ["citron", "finns-inte"] },
      ],
    });

    expect(roleSubstitutionPool(data, "aromatic", "gul-lok")).toEqual(["rodlok", "citron"]);
  });

  it("returns nothing for a role no group is authored under", () => {
    const data = makeEngineData({ ingredients, substitutionGroups: groups });

    expect(roleSubstitutionPool(data, "dairy", "gul-lok")).toEqual([]);
  });
});

describe("classifyCostTier", () => {
  const data = makeEngineData({
    ingredients: [
      makeIngredient("torsk", { default_cost_tier: "mid" }),
      makeIngredient("lax", { default_cost_tier: "premium" }),
      makeIngredient("makrill", { default_cost_tier: "budget" }),
      makeIngredient("sej", { default_cost_tier: "mid" }),
    ],
  });

  it("classes a strictly lower curated tier as cheaper", () => {
    const { cheaper } = classifyCostTier(data, ["makrill"], "mid");
    expect(cheaper).toEqual(["makrill"]);
  });

  it("classes an equal curated tier as similar", () => {
    const { similar } = classifyCostTier(data, ["sej"], "mid");
    expect(similar).toEqual(["sej"]);
  });

  it("classes a strictly higher curated tier as neither", () => {
    const result = classifyCostTier(data, ["lax"], "mid");
    expect(result.cheaper).toEqual([]);
    expect(result.similar).toEqual([]);
  });

  it("partitions a mixed candidate set, preserving input order within each bucket", () => {
    const result = classifyCostTier(data, ["lax", "makrill", "sej", "torsk"], "mid");
    expect(result.cheaper).toEqual(["makrill"]);
    expect(result.similar).toEqual(["sej", "torsk"]);
  });
});

describe("evaluateTemplateAgainstConstraints", () => {
  // #133: the diner-change "keep the dish if still safe" flow asks this question
  // of one template directly, and must never disagree with what
  // `selectCandidateTemplates` would have said about the whole catalog.
  const template = makeTemplate("kycklinggryta", {
    ingredient_slots: [makeSlot({ role: "protein", ingredient_id: "kyckling", substitutable: false })],
  });
  const withCatalog = makeEngineData({
    ingredients: [makeIngredient("kyckling", { category: "protein" })],
    templates: [template],
  });

  it("returns the candidate when the template survives", () => {
    const result = evaluateTemplateAgainstConstraints(withCatalog, template, { dietary_flags: [] });

    expect(result).toEqual({ candidate: { template, substitutions: [] } });
  });

  it("reports missing dietary flags when the template lacks the tag", () => {
    const result = evaluateTemplateAgainstConstraints(withCatalog, template, {
      dietary_flags: ["vegan"],
    });

    expect(result).toEqual({ missingDietaryFlags: ["vegan"] });
  });

  it("reports the unresolvable slot when the catalog does not know its ingredient", () => {
    const data = makeEngineData({ templates: [template] });

    const result = evaluateTemplateAgainstConstraints(data, template, { dietary_flags: [] });

    expect(result).toEqual({ unknownSlotIngredient: { slotIndex: 0, ingredientId: "kyckling" } });
  });

  it("answers the dietary question first — a household is told about the flag, not the catalog", () => {
    // Both failures apply at once. The dietary one is the only one that names a
    // reason a household can act on (#133's replacement copy), so it has to win.
    const data = makeEngineData({ templates: [template] });

    const result = evaluateTemplateAgainstConstraints(data, template, { dietary_flags: ["vegan"] });

    expect(result).toEqual({ missingDietaryFlags: ["vegan"] });
  });

  it("agrees with selectCandidateTemplates: excluded from the evaluation means excluded from the catalog scan", () => {
    const constraints: MealConstraints = { dietary_flags: ["vegan"] };

    const evaluation = evaluateTemplateAgainstConstraints(withCatalog, template, constraints);
    const catalogResult = selectCandidateTemplates(withCatalog, constraints);

    expect("candidate" in evaluation).toBe(false);
    expect(catalogResult).toEqual([]);
  });
});

describe("recipe template dietary tag invariant", () => {
  it("every vegan-tagged template is also tagged vegetarian", () => {
    // Relied on by the dietary filter: a household selecting both flags is filtered
    // by conjunction rather than special-casing vegan as implying vegetarian.
    const veganOnly = data.templates.filter(
      (template) =>
        template.dietary_tags.includes("vegan") && !template.dietary_tags.includes("vegetarian"),
    );

    expect(veganOnly).toEqual([]);
  });
});
