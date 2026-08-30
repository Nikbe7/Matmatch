import { describe, expect, it } from "vitest";
import { buildPantryIngredientOptions, PANTRY_GRID_SIZE } from "../api/guidedCatalog.js";
import { selectCandidateTemplates } from "./candidates.js";
import { isSameVariety, varietyBridgeNote } from "./catalog.js";
import { loadEngineData } from "./data.js";
import { coveredPantryIngredients } from "./ranking.js";
import { makeConstraints as household } from "./__fixtures__/household.js";

// #219, #220 and #221 as one file, because they are one claim split three ways: the
// pantry question is answered by the *variety* relation, which lives inside the
// substitution groups next to a wider one meant for the swap popover (#124).
//
// Against the REAL catalog throughout, like pantryOrdering.test.ts and for the same
// reason: every number here is a claim about what a household actually sees, and a
// fixture would only prove that the code does what the fixture says. The five false
// positives below were found in the real data and are the reason #221 exists — a
// fixture-shaped version of them would have been written to pass.

const data = await loadEngineData();
const unconstrained = household({ dietary_flags: [] });
const candidates = selectCandidateTemplates(data, unconstrained);

/** In how many of the household's dishes a pantry of `{have}` covers the slot `slot`. */
function dishesCovering(have: string, slot: string): string[] {
  return candidates
    .filter((candidate) =>
      coveredPantryIngredients(data, candidate, new Set([have])).some(
        (entry) => entry.ingredientId === slot,
      ),
    )
    .map((candidate) => candidate.template.name);
}

describe("pantry coverage runs through varieties, not the whole substitution group", () => {
  // The bug #221 was filed for, verified against the real catalog on 2026-08-28 and
  // re-verified here: every one of these pairs shares a substitution group, so a
  // group-wide match put the second under "Har hemma" for a household that only ever
  // marked the first. Being sent to the stove without garlic because the app decided
  // onion would do is worse than not being credited for your rice.
  const FALSE_POSITIVES: readonly [string, string][] = [
    ["gul-lok", "vitlok"],
    ["morot", "rodbeta"],
    ["citron", "lime"],
    ["tomatpure", "ketchup"],
    ["jordnotter", "cashewnotter"],
  ];

  it.each(FALSE_POSITIVES)('marking "%s" never covers "%s"', (have, slot) => {
    // The pair really does share a group — otherwise this test would pass for the
    // wrong reason the day someone splits the group instead of the relation.
    const shareGroup = (data.substitutionGroupsByMemberIngredientId.get(have) ?? []).some((group) =>
      group.member_ingredient_ids.includes(slot),
    );
    expect(shareGroup).toBe(true);
    expect(isSameVariety(data, have, slot)).toBe(false);

    expect(dishesCovering(have, slot)).toEqual([]);
  });

  it("still covers the eleven jasminris dishes and the three basmatiris ones for a household that marked ris", () => {
    // #219's headline case. Counts, not a non-empty assertion: the whole finding was
    // that these dishes were reachable and uncredited, so the number is the claim.
    expect(dishesCovering("ris", "jasminris")).toHaveLength(11);
    expect(dishesCovering("ris", "basmatiris")).toHaveLength(3);
  });

  it("covers the other everyday varieties too", () => {
    // Counts, not `toBeGreaterThan(0)`. The weaker assertion passed while coverage was
    // still filtered by the slot's role, which silently missed the two prästost dishes
    // whose slot happens to be `protein` — a test that cannot see a missing half is not
    // watching the thing it was written for.
    expect(dishesCovering("matlagningsgradde", "vispgradde")).toHaveLength(2);
    expect(dishesCovering("hushallsost", "prastost")).toHaveLength(5);
    expect(dishesCovering("potatis", "nypotatis")).toHaveLength(4);
  });

  it("covers a variety whatever role the slot gives it", () => {
    // Three variety classes span both `dairy` and `protein` slots in the live catalog,
    // so "does the household own this product" must not be answered per slot. Asserted
    // as the role span itself plus the coverage, because the day the catalog stops
    // spanning roles is the day this test starts passing for the wrong reason.
    const rolesFor = (ingredientId: string) =>
      new Set(
        candidates.flatMap((candidate) =>
          candidate.template.ingredient_slots
            .filter((slot) => slot.ingredient_id === ingredientId)
            .map((slot) => slot.role),
        ),
      );

    expect(rolesFor("prastost")).toEqual(new Set(["dairy", "protein"]));
    expect(rolesFor("hushallsost")).toEqual(new Set(["dairy", "protein"]));

    for (const name of ["Pasta aglio e olio med prästost", "Friterat ris med prästost och grönsaker"]) {
      expect(dishesCovering("hushallsost", "prastost")).toContain(name);
    }
    for (const name of ["Mac and cheese med hushållsost", "Ostpaj med purjolök"]) {
      expect(dishesCovering("prastost", "hushallsost")).toContain(name);
    }
  });

  it("never misses a variety a household actually marked, over the whole catalog", () => {
    // The mirror of the false-positive sweep below: that one proves nothing is claimed
    // that was not marked, this one proves nothing marked is quietly dropped. Coverage
    // has two ways to lie and both need a sweep.
    const missed: string[] = [];

    for (const ingredientId of data.ingredientsById.keys()) {
      for (const candidate of candidates) {
        const covered = new Set(
          coveredPantryIngredients(data, candidate, new Set([ingredientId])).map(
            (entry) => entry.ingredientId,
          ),
        );
        for (const slot of candidate.template.ingredient_slots) {
          if (slot.ingredient_id === ingredientId) continue;
          if (!isSameVariety(data, slot.ingredient_id, ingredientId)) continue;
          if (covered.has(slot.ingredient_id)) continue;
          missed.push(`${ingredientId} -> ${slot.ingredient_id} (${candidate.template.name})`);
        }
      }
    }

    expect(missed).toEqual([]);
  });

  it("names the ingredient the household marked, not the one the slot says", () => {
    // #219: the two halves of a coverage pair are different ingredients now, and the
    // explanation line reads the pantry half. A card that says "valt för att ni har
    // jasminris hemma" credits a tap nobody made.
    const dish = candidates.find((candidate) =>
      candidate.template.ingredient_slots.some((slot) => slot.ingredient_id === "jasminris"),
    );
    const entry = coveredPantryIngredients(data, dish!, new Set(["ris"])).find(
      (covered) => covered.ingredientId === "jasminris",
    );

    expect(entry).toEqual({ ingredientId: "jasminris", pantryIngredientId: "ris" });
  });

  it("leaves an ingredient with no variety key matching only itself", () => {
    // 169 of 206 ingredients carry no key. Two of them are never varieties of each
    // other — absence is not a value that can compare equal.
    expect(data.ingredientsById.get("vitlok")?.variety_of).toBeUndefined();
    expect(isSameVariety(data, "vitlok", "vitlok")).toBe(false);

    const dish = candidates.find((candidate) =>
      candidate.template.ingredient_slots.some((slot) => slot.ingredient_id === "vitlok"),
    );
    expect(
      coveredPantryIngredients(data, dish!, new Set(["vitlok"])).map((entry) => entry.ingredientId),
    ).toContain("vitlok");
  });

  it("never claims coverage a household did not ask for, over the whole catalog", () => {
    // The sweep behind the five cases above: for every dish and every single-item
    // pantry, a covered slot is either the marked ingredient itself or a variety of it.
    // Nothing weaker can be said about a screen that tells people what they own.
    const offenders: string[] = [];

    for (const ingredientId of data.ingredientsById.keys()) {
      for (const candidate of candidates) {
        for (const entry of coveredPantryIngredients(data, candidate, new Set([ingredientId]))) {
          if (entry.ingredientId === ingredientId) continue;
          if (isSameVariety(data, entry.ingredientId, ingredientId)) continue;
          offenders.push(`${ingredientId} -> ${entry.ingredientId} (${candidate.template.name})`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("the pantry grid offers one square per variety, not per group", () => {
  const options = buildPantryIngredientOptions(data, candidates);

  it("still offers a full grid after the collapses", () => {
    // #220: freed places are filled from below, so collapsing ris/jasminris shortens
    // nothing — it hands the place to the next staple down.
    expect(options).toHaveLength(PANTRY_GRID_SIZE);
  });

  it("never shows two squares from one variety class", () => {
    const byVariety = new Map<string, string>();
    const duplicates: string[] = [];

    for (const option of options) {
      const variety = data.ingredientsById.get(option.id)?.variety_of;
      if (variety === undefined) continue;
      const previous = byVariety.get(variety);
      if (previous) duplicates.push(`${variety}: ${previous} + ${option.id}`);
      byVariety.set(variety, option.id);
    }

    expect(duplicates).toEqual([]);
  });

  it("keeps ris and drops jasminris, and keeps gul lök and vitlök apart", () => {
    const ids = options.map((option) => option.id);

    // The two squares on the same product that #220 was filed for — a question no
    // household could answer correctly.
    expect(ids).toContain("ris");
    expect(ids).not.toContain("jasminris");

    // And the collapse the wider relation would have made: two things a household
    // genuinely has separately, which must stay two taps.
    expect(ids).toContain("gul-lok");
    expect(ids).toContain("vitlok");
  });

  it("keeps the survivor's own id and name — no group ids leak into the grid", () => {
    for (const option of options) {
      const ingredient = data.ingredientsById.get(option.id);
      expect(ingredient).toBeDefined();
      expect(option.name).toBe(ingredient!.name);
    }
  });

  it("is deterministic", () => {
    expect(buildPantryIngredientOptions(data, candidates)).toEqual(options);
  });
});

// #223 — the note the family carries, against the REAL curated data for the same
// reason as everything else in this file: whether a household is warned that its
// sauce will come out thicker is a claim about the shipped catalog, and a fixture
// would only prove that the code reads the fixture.
describe("a variety that covers a slot says what will be different", () => {
  it("names the grädde difference when vispgrädde covers a matlagningsgrädde slot", () => {
    // The exact case #223 was filed for: coverage *marks*, it never swaps or
    // rescales, so this sentence is the only thing between the household and a
    // silently different sauce.
    const note = varietyBridgeNote(data, "matlagningsgradde", "vispgradde");

    expect(note).toContain("vispgrädde");
    expect(note).toContain("matlagningsgrädde");
  });

  it("says the same thing in the other direction — the families are unordered", () => {
    expect(varietyBridgeNote(data, "vispgradde", "matlagningsgradde")).toBe(
      varietyBridgeNote(data, "matlagningsgradde", "vispgradde"),
    );
  });

  it("says nothing when the pantry item is the dish's own ingredient", () => {
    expect(varietyBridgeNote(data, "potatis", "potatis")).toBeUndefined();
  });

  it("says nothing between two ingredients that are not varieties of each other", () => {
    // morot and rödbeta share a substitution group but no variety family — the
    // #221 distinction this whole file exists for.
    expect(varietyBridgeNote(data, "morot", "rodbeta")).toBeUndefined();
  });

  it("says nothing for a family curated as needing no note", () => {
    // tomat/körsbärstomat are a real family with no note: they differ, but not in a
    // way worth a sentence. Absent is the normal case and must stay silent.
    expect(isSameVariety(data, "tomat", "korsbarstomat")).toBe(true);
    expect(varietyBridgeNote(data, "tomat", "korsbarstomat")).toBeUndefined();
  });

  it("carries a note for 9 of the 16 curated families, and none of them states a number", () => {
    // A guard on the curation pass's size and on CLAUDE.md's non-negotiable at once:
    // the engine holds no fat content or density to compute an adjustment from, and
    // a model must not invent one. A note that grew a digit is the shape that failure
    // would take.
    const withNote = [...data.varietyFamiliesById.values()].filter((family) => family.note);

    expect(data.varietyFamiliesById.size).toBe(16);
    expect(withNote).toHaveLength(9);
    for (const family of withNote) expect(family.note).not.toMatch(/\d/);
  });
});
