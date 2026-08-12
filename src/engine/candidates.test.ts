import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AllergySchema, type Allergy } from "../schema/allergyDietary.js";
import {
  classifyCostTier,
  evaluateTemplateAgainstConstraints,
  roleSubstitutionPool,
  selectCandidateTemplates,
  substituteCandidateIds,
} from "./candidates.js";
import { ALLERGIES } from "../schema/vocabulary.js";
import { mealDiners, type MealConstraints } from "./constraints.js";
import type { HouseholdMember } from "../schema/household.js";
import { loadEngineData } from "./data.js";
import { makeEngineData, makeIngredient, makeSlot, makeTemplate } from "./__fixtures__/engineData.js";
import { makeConstraints as household } from "./__fixtures__/household.js";

// `household(...)` keeps the pre-#115 call shape on purpose — see the fixture's own
// comment. Every expectation below is unchanged from before constraints moved onto
// members, which is what makes this file part of the behavior-preservation evidence.

describe("selectCandidateTemplates — substitution rescue rules", () => {
  // gul-lok is excluded for this household; rodlok is the safe alternative.
  const ingredients = [
    makeIngredient("kyckling", { category: "protein" }),
    makeIngredient("gul-lok"),
    makeIngredient("rodlok"),
    makeIngredient("potatis", { category: "starch" }),
  ];
  const allergenMappings = [
    { ingredient_id: "kyckling", allergens: [], verification_status: "verified" as const },
    { ingredient_id: "gul-lok", allergens: ["soy" as Allergy], verification_status: "verified" as const },
    { ingredient_id: "rodlok", allergens: [], verification_status: "verified" as const },
    { ingredient_id: "potatis", allergens: [], verification_status: "verified" as const },
  ];
  const aromaticGroup = {
    id: "lok",
    name: "Lök",
    role: "aromatic" as const,
    member_ingredient_ids: ["gul-lok", "rodlok"],
  };

  const soyHousehold = household({ allergies: ["soy"] });

  it("rescues a substitutable slot with the first edible member of a matching group", () => {
    const data = makeEngineData({
      ingredients,
      allergenMappings,
      substitutionGroups: [aromaticGroup],
      templates: [
        makeTemplate("gryta", {
          ingredient_slots: [
            makeSlot({ role: "protein", ingredient_id: "kyckling", substitutable: false }),
            makeSlot({ role: "aromatic", ingredient_id: "gul-lok", substitutable: true }),
          ],
        }),
      ],
    });

    const candidates = selectCandidateTemplates(data, soyHousehold);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.substitutions).toEqual([
      {
        slot_index: 1,
        slot: makeSlot({ role: "aromatic", ingredient_id: "gul-lok", substitutable: true }),
        substitute_ingredient_id: "rodlok",
      },
    ]);
  });

  it("never rescues a non-substitutable slot, even when a matching group contains its ingredient", () => {
    const data = makeEngineData({
      ingredients,
      allergenMappings,
      substitutionGroups: [aromaticGroup],
      templates: [
        makeTemplate("gryta", {
          ingredient_slots: [
            // Same ingredient and same role as the group above — only the flag differs.
            makeSlot({ role: "aromatic", ingredient_id: "gul-lok", substitutable: false }),
          ],
        }),
      ],
    });

    expect(selectCandidateTemplates(data, soyHousehold)).toEqual([]);
  });

  it("only rescues from a group whose role matches the slot's role", () => {
    const data = makeEngineData({
      ingredients,
      allergenMappings,
      // Identical members, wrong role for the slot below.
      substitutionGroups: [{ ...aromaticGroup, role: "vegetable" as const }],
      templates: [
        makeTemplate("gryta", {
          ingredient_slots: [makeSlot({ role: "aromatic", ingredient_id: "gul-lok", substitutable: true })],
        }),
      ],
    });

    expect(selectCandidateTemplates(data, soyHousehold)).toEqual([]);
  });

  it("excludes a template when no member of the matching group is edible", () => {
    const data = makeEngineData({
      ingredients,
      allergenMappings: allergenMappings.map((row) =>
        row.ingredient_id === "rodlok" ? { ...row, allergens: ["soy" as Allergy] } : row,
      ),
      substitutionGroups: [aromaticGroup],
      templates: [
        makeTemplate("gryta", {
          ingredient_slots: [makeSlot({ role: "aromatic", ingredient_id: "gul-lok", substitutable: true })],
        }),
      ],
    });

    expect(selectCandidateTemplates(data, soyHousehold)).toEqual([]);
  });

  it("rescues several slots of the same template at once", () => {
    const data = makeEngineData({
      ingredients: [...ingredients, makeIngredient("purjolok"), makeIngredient("farskpotatis")],
      allergenMappings: [
        ...allergenMappings.map((row) =>
          row.ingredient_id === "potatis" ? { ...row, allergens: ["soy" as Allergy] } : row,
        ),
        { ingredient_id: "purjolok", allergens: [], verification_status: "verified" as const },
        { ingredient_id: "farskpotatis", allergens: [], verification_status: "verified" as const },
      ],
      substitutionGroups: [
        aromaticGroup,
        {
          id: "potatis",
          name: "Potatis",
          role: "starch" as const,
          member_ingredient_ids: ["potatis", "farskpotatis"],
        },
      ],
      templates: [
        makeTemplate("gryta", {
          ingredient_slots: [
            makeSlot({ role: "aromatic", ingredient_id: "gul-lok", substitutable: true }),
            makeSlot({ role: "starch", ingredient_id: "potatis", substitutable: true }),
          ],
        }),
      ],
    });

    const candidates = selectCandidateTemplates(data, soyHousehold);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.substitutions.map((s) => s.substitute_ingredient_id)).toEqual([
      "rodlok",
      "farskpotatis",
    ]);
  });

  it("returns the stored cost_tier unchanged for a rescued template", () => {
    // The effective cost tier of a swapped meal is deliberately undefined until the
    // engine has to render one — DECISION_LOG 2026-08-01, substitution groups.
    const data = makeEngineData({
      ingredients,
      allergenMappings,
      substitutionGroups: [aromaticGroup],
      templates: [
        makeTemplate("gryta", {
          cost_tier: "premium",
          ingredient_slots: [makeSlot({ role: "aromatic", ingredient_id: "gul-lok", substitutable: true })],
        }),
      ],
    });

    expect(selectCandidateTemplates(data, soyHousehold)[0]!.template.cost_tier).toBe("premium");
  });

  it("does not mutate the loaded template", () => {
    const template = makeTemplate("gryta", {
      ingredient_slots: [makeSlot({ role: "aromatic", ingredient_id: "gul-lok", substitutable: true })],
    });
    const snapshot = structuredClone(template);
    const data = makeEngineData({
      ingredients,
      allergenMappings,
      substitutionGroups: [aromaticGroup],
      templates: [template],
    });

    selectCandidateTemplates(data, soyHousehold);

    expect(template).toEqual(snapshot);
  });

  it("excludes a template whose slot ingredient is absent from the catalog", () => {
    const data = makeEngineData({
      ingredients,
      allergenMappings,
      templates: [
        makeTemplate("gryta", {
          ingredient_slots: [makeSlot({ role: "protein", ingredient_id: "finns-inte", substitutable: false })],
        }),
      ],
    });

    expect(selectCandidateTemplates(data, household())).toEqual([]);
  });
});

describe("selectCandidateTemplates — dietary flags", () => {
  const data = makeEngineData({
    ingredients: [makeIngredient("morot")],
    allergenMappings: [
      { ingredient_id: "morot", allergens: [], verification_status: "verified" as const },
    ],
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

describe("selectCandidateTemplates — meal_types hard filter (#68)", () => {
  const data = makeEngineData({
    ingredients: [makeIngredient("morot")],
    allergenMappings: [
      { ingredient_id: "morot", allergens: [], verification_status: "verified" as const },
    ],
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

  it("excludes any template whose meal_types does not include dinner, even though it is otherwise safe", () => {
    const ids = selectCandidateTemplates(data, household()).map((candidate) => candidate.template.id);
    expect(ids).toEqual(["lunch-och-middag", "bara-middag"]);
  });
});

// --- Real-data assertions ------------------------------------------------------
// Everything below runs against data/*.json, the artifact the Phase 0 exit review
// (#21) measured.

const data = await loadEngineData();

interface AllergenRow {
  ingredient_id: string;
  allergens: Allergy[];
  verification_status: "verified" | "unverified";
}

// Read independently of the engine: the exhaustive sweep below must not be able to
// agree with a broken resolver by using it.
const allergenRows = JSON.parse(
  await readFile(new URL("../../data/ingredient-allergens.json", import.meta.url), "utf8"),
) as AllergenRow[];
const rowsByIngredientId = new Map(allergenRows.map((row) => [row.ingredient_id, row]));

/** The ingredients a household actually ends up eating, after applying rescues. */
function effectiveIngredientIds(h: MealConstraints): Set<string> {
  const ids = new Set<string>();
  for (const candidate of selectCandidateTemplates(data, h)) {
    const substituteBySlotIndex = new Map(
      candidate.substitutions.map((s) => [s.slot_index, s.substitute_ingredient_id]),
    );
    candidate.template.ingredient_slots.forEach((slot, index) => {
      ids.add(substituteBySlotIndex.get(index) ?? slot.ingredient_id);
    });
  }
  return ids;
}

describe("selectCandidateTemplates — allergen safety over the real catalog", () => {
  // Exhaustive, not sampled (CLAUDE.md non-negotiable): for every allergen in the
  // locked vocabulary, nothing an allergic household could be served may contain it.
  it.each(AllergySchema.options)(
    "never surfaces an ingredient containing %s to a household allergic to it",
    (allergy) => {
      const offenders = [...effectiveIngredientIds(household({ allergies: [allergy] }))].filter(
        (ingredientId) => {
          const row = rowsByIngredientId.get(ingredientId);
          // Fail-safe, checked here independently of the engine: no row, or an
          // unverified row, is as disqualifying as a row containing the allergen.
          return !row || row.verification_status !== "verified" || row.allergens.includes(allergy);
        },
      );

      expect(offenders).toEqual([]);
    },
  );

  it.each(AllergySchema.options)(
    "never surfaces %s to an allergic household in a vegetarian or vegan profile either",
    (allergy) => {
      for (const flag of ["vegetarian", "vegan"] as const) {
        const offenders = [
          ...effectiveIngredientIds(household({ allergies: [allergy], dietary_flags: [flag] })),
        ].filter((ingredientId) => rowsByIngredientId.get(ingredientId)?.allergens.includes(allergy));

        expect(offenders).toEqual([]);
      }
    },
  );

  it("every ingredient referenced by a surviving template resolves in the catalog", () => {
    for (const ingredientId of effectiveIngredientIds(household())) {
      expect(data.ingredientsById.has(ingredientId)).toBe(true);
    }
  });
});

describe("selectCandidateTemplates — diner-scoped constraints over the real catalog (#112)", () => {
  // The same exhaustive sweep as above, run across diner subsets rather than over one
  // household: for every allergen in the locked vocabulary, deselecting its carrier
  // must stop it excluding dishes, and selecting them must still exclude every one.
  //
  // Two members, only the first restricted, so "who is eating" is the only variable.
  function roster(allergy: Allergy): HouseholdMember[] {
    return [
      { type: "adult", portion_factor: 1, allergies: [allergy], dietary_flags: [] },
      { type: "adult", portion_factor: 1, allergies: [], dietary_flags: [] },
    ];
  }

  /** What a household with nothing declared sees — the ceiling every subset works under. */
  const unrestricted = selectCandidateTemplates(data, household());

  it.each(AllergySchema.options)(
    "deselecting the member allergic to %s stops their allergen excluding dishes",
    (allergy) => {
      const members = roster(allergy);
      const withoutCarrier = mealDiners(members, new Set([1]));

      expect(withoutCarrier.constraints.allergies).toEqual([]);
      // Not merely "more dishes": exactly the set an unrestricted household sees.
      expect(selectCandidateTemplates(data, withoutCarrier.constraints).map((c) => c.template.id))
        .toEqual(unrestricted.map((c) => c.template.id));
    },
  );

  it.each(AllergySchema.options)(
    "keeping the member allergic to %s still excludes every dish containing it",
    (allergy) => {
      const members = roster(allergy);
      const withCarrier = mealDiners(members, new Set([0, 1]));

      const offenders = [...effectiveIngredientIds(withCarrier.constraints)].filter(
        (ingredientId) => {
          const row = rowsByIngredientId.get(ingredientId);
          return !row || row.verification_status !== "verified" || row.allergens.includes(allergy);
        },
      );

      expect(offenders).toEqual([]);
    },
  );

  it.each(AllergySchema.options)(
    "a fail-closed diner set is filtered exactly as the full household is (%s)",
    (allergy) => {
      const members = roster(allergy);
      const strict = selectCandidateTemplates(data, mealDiners(members).constraints).map(
        (c) => c.template.id,
      );

      // Absent, empty and out-of-range must each land on the *restricted* set — the
      // failure that matters is a bad diner parameter quietly serving the allergen.
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
    // containing dishes for an allergen: at least one allergy must genuinely change
    // the candidate set, or the "stops excluding dishes" assertion proves nothing.
    const widened = AllergySchema.options.filter((allergy) => {
      const members = roster(allergy);
      return (
        selectCandidateTemplates(data, mealDiners(members).constraints).length <
        selectCandidateTemplates(data, mealDiners(members, new Set([1])).constraints).length
      );
    });

    expect(widened).toEqual([...AllergySchema.options]);
  });
});

describe("selectCandidateTemplates — survival counts (DECISION_LOG 2026-08-02)", () => {
  // Regression pins on the Phase 0 exit review's measured numbers. A disagreement
  // here means either the review or this engine is wrong — investigate, do not
  // adjust the expected value.
  //
  // Updated for #68: the meal_types hard filter removes 14 breakfast/lunch-only
  // templates from every count below, deliberately and up front, before allergy/
  // dietary filtering ever runs — this is the one exception to "do not adjust the
  // expected value" above, since the underlying candidate set itself changed.
  //
  // Updated again for the ranking-defaults fix: pannkakor-med-vaniljsocker and
  // artsoppa-med-senap lost "dinner" from meal_types (data correction, not a new
  // exclusion rule), dropping every count below that included them by one more.
  //
  // Updated again for the meal_types dinner-bar tightening (see DECISION_LOG):
  // raggmunk-med-graddfil, potatisgratang-med-vasterbottensost,
  // purjolokssoppa-med-creme-fraiche, ostsoppa-med-brod-och-vitlok,
  // gravad-lax-med-senapssas-och-ragbrod and rakceviche-med-lime-och-koriander
  // lost "dinner", dropping every count below that included them by one more.
  const countFor = (h: MealConstraints) => selectCandidateTemplates(data, h).length;

  it("a household with no allergies and no dietary flags sees all 148 dinner-eligible templates", () => {
    expect(countFor(household())).toBe(148);
  });

  it("gluten alone leaves 98 templates after substitution rescue", () => {
    expect(countFor(household({ allergies: ["gluten"] }))).toBe(98);
  });

  it("vegan + gluten leaves 16 templates", () => {
    expect(countFor(household({ allergies: ["gluten"], dietary_flags: ["vegan"] }))).toBe(16);
  });

  it("vegan + soy leaves 17 templates, with zero rescued", () => {
    const candidates = selectCandidateTemplates(
      data,
      household({ allergies: ["soy"], dietary_flags: ["vegan"] }),
    );

    expect(candidates).toHaveLength(17);
    expect(candidates.filter((candidate) => candidate.substitutions.length > 0)).toEqual([]);
  });

  it("gluten rescue adds 29 templates over raw survival", () => {
    const candidates = selectCandidateTemplates(data, household({ allergies: ["gluten"] }));
    const rescued = candidates.filter((candidate) => candidate.substitutions.length > 0);

    expect(candidates.length - rescued.length).toBe(69);
    expect(rescued).toHaveLength(29);
  });
});

// #124: the ingredient-swap popover's traversal, tested directly rather than only
// through selectCandidateTemplates/findSubstitute.
describe("substituteCandidateIds", () => {
  const ingredients = [
    makeIngredient("gul-lok"),
    makeIngredient("rodlok"),
    makeIngredient("purjolok"),
    makeIngredient("vitlok", { category: "spice_aromatic" }),
  ];
  const allergenMappings = ingredients.map((ingredient) => ({
    ingredient_id: ingredient.id,
    allergens: [] as Allergy[],
    verification_status: "verified" as const,
  }));
  const group = {
    id: "lok",
    name: "Lök",
    role: "aromatic" as const,
    member_ingredient_ids: ["gul-lok", "rodlok", "purjolok"],
  };

  it("returns every other member of a role-matching group containing the current ingredient", () => {
    const data = makeEngineData({ ingredients, allergenMappings, substitutionGroups: [group] });

    expect(substituteCandidateIds(data, "aromatic", "gul-lok", [])).toEqual(["rodlok", "purjolok"]);
  });

  it("never includes the current ingredient itself", () => {
    const data = makeEngineData({ ingredients, allergenMappings, substitutionGroups: [group] });

    expect(substituteCandidateIds(data, "aromatic", "gul-lok", [])).not.toContain("gul-lok");
  });

  it("excludes a candidate the given allergies would exclude", () => {
    const data = makeEngineData({
      ingredients,
      allergenMappings: allergenMappings.map((row) =>
        row.ingredient_id === "rodlok" ? { ...row, allergens: ["soy" as Allergy] } : row,
      ),
      substitutionGroups: [group],
    });

    expect(substituteCandidateIds(data, "aromatic", "gul-lok", ["soy"])).toEqual(["purjolok"]);
  });

  it("ignores a group whose role does not match", () => {
    const data = makeEngineData({
      ingredients,
      allergenMappings,
      substitutionGroups: [{ ...group, role: "vegetable" as const }],
    });

    expect(substituteCandidateIds(data, "aromatic", "gul-lok", [])).toEqual([]);
  });

  it("de-duplicates a candidate reachable through more than one matching group", () => {
    const data = makeEngineData({
      ingredients,
      allergenMappings,
      substitutionGroups: [
        group,
        { id: "lok-2", name: "Lök 2", role: "aromatic" as const, member_ingredient_ids: ["gul-lok", "rodlok"] },
      ],
    });

    expect(substituteCandidateIds(data, "aromatic", "gul-lok", [])).toEqual(["rodlok", "purjolok"]);
  });

  it("traverses from the given current ingredient, not from any slot's authored one", () => {
    // rodlok is currently in the slot (e.g. after a prior swap); alternatives are
    // relative to rodlok, so gul-lok — not rodlok — must be offered back.
    const data = makeEngineData({ ingredients, allergenMappings, substitutionGroups: [group] });

    expect(substituteCandidateIds(data, "aromatic", "rodlok", [])).toEqual(["gul-lok", "purjolok"]);
  });
});

describe("roleSubstitutionPool", () => {
  const ingredients = [
    makeIngredient("gul-lok"),
    makeIngredient("rodlok"),
    makeIngredient("citron", { category: "fruit" }),
    makeIngredient("lime", { category: "fruit" }),
  ];
  const allergenMappings = ingredients.map((ingredient) => ({
    ingredient_id: ingredient.id,
    allergens: [] as Allergy[],
    verification_status: "verified" as const,
  }));
  const groups = [
    { id: "lok", name: "Lök", role: "aromatic" as const, member_ingredient_ids: ["gul-lok", "rodlok"] },
    { id: "citrus", name: "Citrus", role: "aromatic" as const, member_ingredient_ids: ["citron", "lime"] },
  ];

  it("unions every role-matching group, not just groups containing the excluded ingredient", () => {
    const data = makeEngineData({ ingredients, allergenMappings, substitutionGroups: groups });

    expect(roleSubstitutionPool(data, "aromatic", "gul-lok", [])).toEqual(["rodlok", "citron", "lime"]);
  });

  it("excludes the given ingredient id even from a group it is not itself a member of", () => {
    const data = makeEngineData({ ingredients, allergenMappings, substitutionGroups: groups });

    expect(roleSubstitutionPool(data, "aromatic", "citron", [])).not.toContain("citron");
  });

  it("excludes a member the given allergies would exclude", () => {
    const data = makeEngineData({
      ingredients,
      allergenMappings: allergenMappings.map((row) =>
        row.ingredient_id === "lime" ? { ...row, allergens: ["gluten" as Allergy] } : row,
      ),
      substitutionGroups: groups,
    });

    expect(roleSubstitutionPool(data, "aromatic", "gul-lok", ["gluten"])).toEqual(["rodlok", "citron"]);
  });

  it("returns nothing for a role no group is authored under", () => {
    const data = makeEngineData({ ingredients, allergenMappings, substitutionGroups: groups });

    expect(roleSubstitutionPool(data, "dairy", "gul-lok", [])).toEqual([]);
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
  const nonSubstitutableIngredientId = "kyckling";
  const template = makeTemplate("kycklinggryta", {
    ingredient_slots: [
      makeSlot({ role: "protein", ingredient_id: nonSubstitutableIngredientId, substitutable: false }),
    ],
  });

  it("returns the candidate when the template survives", () => {
    const data = makeEngineData({
      ingredients: [makeIngredient(nonSubstitutableIngredientId, { category: "protein" })],
      allergenMappings: [
        { ingredient_id: nonSubstitutableIngredientId, allergens: [], verification_status: "verified" },
      ],
      templates: [template],
    });

    const result = evaluateTemplateAgainstConstraints(data, template, { allergies: [], dietary_flags: [] });

    expect(result).toEqual({ candidate: { template, substitutions: [] } });
  });

  it.each(ALLERGIES)(
    "reports the unrescuable slot when %s is the only thing that excludes it",
    (allergy) => {
      const data = makeEngineData({
        ingredients: [makeIngredient(nonSubstitutableIngredientId, { category: "protein" })],
        allergenMappings: [
          {
            ingredient_id: nonSubstitutableIngredientId,
            allergens: [allergy],
            verification_status: "verified",
          },
        ],
        templates: [template],
      });

      const result = evaluateTemplateAgainstConstraints(data, template, {
        allergies: [allergy],
        dietary_flags: [],
      });

      expect(result).toEqual({
        unsafeSlot: { slotIndex: 0, ingredientId: nonSubstitutableIngredientId },
      });
    },
  );

  it("agrees with selectCandidateTemplates: excluded from the evaluation means excluded from the catalog scan", () => {
    const data = makeEngineData({
      ingredients: [makeIngredient(nonSubstitutableIngredientId, { category: "protein" })],
      allergenMappings: [
        {
          ingredient_id: nonSubstitutableIngredientId,
          allergens: ["gluten"],
          verification_status: "verified",
        },
      ],
      templates: [template],
    });
    const constraints: MealConstraints = { allergies: ["gluten"], dietary_flags: [] };

    const evaluation = evaluateTemplateAgainstConstraints(data, template, constraints);
    const catalogResult = selectCandidateTemplates(data, constraints);

    expect("candidate" in evaluation).toBe(false);
    expect(catalogResult).toEqual([]);
  });

  it("reports missing dietary flags rather than an unsafe slot when the mismatch is dietary", () => {
    const data = makeEngineData({ templates: [template] });

    const result = evaluateTemplateAgainstConstraints(data, template, {
      allergies: [],
      dietary_flags: ["vegan"],
    });

    expect(result).toEqual({ missingDietaryFlags: ["vegan"] });
  });

  it("rescues a substitutable slot instead of reporting it unsafe", () => {
    const ingredients = [
      makeIngredient("kyckling", { category: "protein" }),
      makeIngredient("gul-lok"),
      makeIngredient("rodlok"),
    ];
    const allergenMappings = [
      { ingredient_id: "kyckling", allergens: [], verification_status: "verified" as const },
      { ingredient_id: "gul-lok", allergens: ["soy" as Allergy], verification_status: "verified" as const },
      { ingredient_id: "rodlok", allergens: [], verification_status: "verified" as const },
    ];
    const rescuable = makeTemplate("gryta", {
      ingredient_slots: [
        makeSlot({ role: "protein", ingredient_id: "kyckling", substitutable: false }),
        makeSlot({ role: "aromatic", ingredient_id: "gul-lok", substitutable: true }),
      ],
    });
    const data = makeEngineData({
      ingredients,
      allergenMappings,
      substitutionGroups: [
        { id: "lok", name: "Lök", role: "aromatic" as const, member_ingredient_ids: ["gul-lok", "rodlok"] },
      ],
      templates: [rescuable],
    });

    const result = evaluateTemplateAgainstConstraints(data, rescuable, {
      allergies: ["soy"],
      dietary_flags: [],
    });

    expect(result).toEqual({
      candidate: {
        template: rescuable,
        substitutions: [
          {
            slot_index: 1,
            slot: makeSlot({ role: "aromatic", ingredient_id: "gul-lok", substitutable: true }),
            substitute_ingredient_id: "rodlok",
          },
        ],
      },
    });
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
