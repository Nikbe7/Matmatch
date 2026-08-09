import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AllergySchema, type Allergy } from "../schema/allergyDietary.js";
import { selectCandidateTemplates } from "./candidates.js";
import type { MealConstraints } from "./constraints.js";
import { loadEngineData } from "./data.js";
import { makeEngineData, makeIngredient, makeTemplate } from "./__fixtures__/engineData.js";
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
            { role: "protein", ingredient_id: "kyckling", substitutable: false },
            { role: "aromatic", ingredient_id: "gul-lok", substitutable: true },
          ],
        }),
      ],
    });

    const candidates = selectCandidateTemplates(data, soyHousehold);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.substitutions).toEqual([
      {
        slot_index: 1,
        slot: { role: "aromatic", ingredient_id: "gul-lok", substitutable: true },
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
            { role: "aromatic", ingredient_id: "gul-lok", substitutable: false },
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
          ingredient_slots: [{ role: "aromatic", ingredient_id: "gul-lok", substitutable: true }],
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
          ingredient_slots: [{ role: "aromatic", ingredient_id: "gul-lok", substitutable: true }],
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
            { role: "aromatic", ingredient_id: "gul-lok", substitutable: true },
            { role: "starch", ingredient_id: "potatis", substitutable: true },
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
          ingredient_slots: [{ role: "aromatic", ingredient_id: "gul-lok", substitutable: true }],
        }),
      ],
    });

    expect(selectCandidateTemplates(data, soyHousehold)[0]!.template.cost_tier).toBe("premium");
  });

  it("does not mutate the loaded template", () => {
    const template = makeTemplate("gryta", {
      ingredient_slots: [{ role: "aromatic", ingredient_id: "gul-lok", substitutable: true }],
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
          ingredient_slots: [{ role: "protein", ingredient_id: "finns-inte", substitutable: false }],
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
      ingredient_slots: [{ role: "vegetable" as const, ingredient_id: "morot", substitutable: true }],
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
      ingredient_slots: [{ role: "vegetable" as const, ingredient_id: "morot", substitutable: true }],
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
