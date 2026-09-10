import { describe, expect, it } from "vitest";
import { substituteCandidateIds } from "./candidates.js";
import { loadEngineData } from "./data.js";
import { CuisineSchema, type Cuisine } from "../schema/ingredient.js";

// #222, against the REAL catalog — same reason as varietyCoverage.test.ts: every
// claim here is about what a household actually sees in the swap popover, and a
// fixture would only prove the code does what the fixture says. The offers asserted
// gone below were all reproduced in the shipped data before the curation pass.
//
// The unit tests for the gate itself live in candidates.test.ts. This file is about
// the curated data.

const data = await loadEngineData();
const ALL_CUISINES = CuisineSchema.options;

function template(name: string) {
  const found = data.templates.find((candidate) => candidate.name.startsWith(name));
  // A renamed dish must fail loudly rather than quietly assert nothing.
  if (!found) throw new Error(`no recipe template whose name starts with "${name}"`);
  return found;
}

/** What the popover offers for the slot at `slotIndex` of `dish`, by Swedish name. */
function offersFor(dishName: string, slotIndex: number): string[] {
  const found = template(dishName);
  const slot = found.ingredient_slots[slotIndex]!;
  return substituteCandidateIds(data, found.cuisine, slot.role, slot.ingredient_id).map(
    (id) => data.ingredientsById.get(id)!.name,
  );
}

/** The slot index of `ingredientId` in `dishName` — the tests read by name, not index. */
function slotOf(dishName: string, ingredientId: string): number {
  const index = template(dishName).ingredient_slots.findIndex(
    (slot) => slot.ingredient_id === ingredientId,
  );
  if (index < 0) throw new Error(`"${dishName}" has no slot for "${ingredientId}"`);
  return index;
}

describe("a swap offer has to fit the dish, not just the slot", () => {
  // The three cases named in #222, verified against the shipped catalog 2026-08-30.
  it("stops offering sambal oelek in a Texas chili", () => {
    const offers = offersFor("Texas chili", slotOf("Texas chili", "farsk-chili"));

    expect(offers).not.toContain("sambal oelek");
    // Chiliflakes stay, deliberately: chili flakes in a chili are not a culture
    // error, they are what you reach for when the fresh chili ran out.
    expect(offers).toContain("chiliflakes");
  });

  it("stops offering currypasta and gurkmeja in fiskpinnar med currysås", () => {
    const dish = "Fiskpinnar med currysås";
    const offers = offersFor(dish, slotOf(dish, "curry"));

    expect(offers).not.toContain("currypasta");
    expect(offers).not.toContain("gurkmeja");
  });

  it("stops offering vispgrädde in a grön curry, and keeps matlagningsgrädde", () => {
    const dish = "Grön curry med kyckling";
    const offers = offersFor(dish, slotOf(dish, "kokosmjolk"));

    // 40% whipping cream is not a curry. 15% cooking cream is the Swedish home
    // solution #222 explicitly judged defensible — the boundary between them is the
    // curation call this pass had to make, so it is asserted in both directions.
    expect(offers).not.toContain("vispgrädde");
    expect(offers).toContain("matlagningsgrädde");
  });

  it("stops offering sojagroddar and bambuskott in a Swedish kycklingfilé", () => {
    const dish = "Snabbstekt kycklingfilé med sockerärtor";
    const offers = offersFor(dish, slotOf(dish, "sockerartor"));

    expect(offers).not.toContain("sojagroddar");
    expect(offers).not.toContain("bambuskott");
  });

  it("still offers jasminris for the rice in a Swedish dish", () => {
    // The boundary the curation rule turns on: jasmine rice is asian by origin but is
    // what a Swedish rice cupboard holds, so marking it would take away a swap
    // households make on purpose. "Most often used in" is not the rule.
    const dish = "Fiskpinnar med currysås";

    expect(offersFor(dish, slotOf(dish, "ris"))).toContain("jasminris");
  });
});

describe("the cuisines curation pass as a whole", () => {
  it("marks 15 of the 206 ingredients and leaves the rest belonging anywhere", () => {
    // A guard on the pass's size, not on its content: `cuisines` is a veto, and a
    // curation pass that quietly grew to cover the catalog would be a different
    // change than the one #222 asked for and reviewed.
    const marked = [...data.ingredientsById.values()].filter((i) => i.cuisines !== undefined);

    expect(marked).toHaveLength(15);
    expect(data.ingredientsById.size).toBe(206);
  });

  it("never takes a slot from having alternatives to having none", () => {
    // #222's acceptance criterion, read as it can hold: a cuisine filter reduces the
    // number of offers by definition, so "no household gets fewer legal choices than
    // the role already gave" cannot mean the count is unchanged. What it can mean —
    // and what actually matters to a household — is that no slot that could be
    // swapped before became a dead end.
    //
    // The unfiltered pool is the union over every cuisine, which is exact rather than
    // an approximation: `cuisines` is schema-forbidden from being empty, so every
    // candidate is admitted by at least one cuisine.
    const deadEnds: string[] = [];

    for (const found of data.templates) {
      for (const [index, slot] of found.ingredient_slots.entries()) {
        if (!slot.substitutable) continue;
        const unfiltered = new Set(
          ALL_CUISINES.flatMap((cuisine: Cuisine) =>
            substituteCandidateIds(data, cuisine, slot.role, slot.ingredient_id),
          ),
        );
        const offered = substituteCandidateIds(data, found.cuisine, slot.role, slot.ingredient_id);
        if (unfiltered.size > 0 && offered.length === 0) {
          deadEnds.push(`${found.name} [${index}] ${slot.ingredient_id}`);
        }
      }
    }

    expect(deadEnds).toEqual([]);
  });
});

describe("ginger and fresh chili are not the same flavor (#228)", () => {
  // `asiatisk-aromatbas` named a flavor complex ("ginger and chili together as a wok
  // base"), not the interchangeable-member-for-member relation a substitution group
  // means. Removed rather than fixed: ginger is not culinarily bound to Asian
  // cooking (it shows up in Swedish home cooking too, so #222's cuisine tag was
  // rightly rejected for it), and the two ingredients are not swaps for each other
  // in any dish — one is heat, the other is warmth. Reproduced in the shipped
  // catalog 2026-08-30, across both directions, before this fix.
  it("never offers ginger as a substitute for fresh chili, or the reverse, in any dish", () => {
    const wrongOffers: string[] = [];

    for (const found of data.templates) {
      found.ingredient_slots.forEach((slot, index) => {
        if (slot.ingredient_id !== "farsk-chili" && slot.ingredient_id !== "ingefara") return;
        const offers = substituteCandidateIds(data, found.cuisine, slot.role, slot.ingredient_id);
        const swapId = slot.ingredient_id === "farsk-chili" ? "ingefara" : "farsk-chili";
        if (offers.includes(swapId)) {
          wrongOffers.push(`${found.name} [${index}] ${slot.ingredient_id} -> ${swapId}`);
        }
      });
    }

    expect(wrongOffers).toEqual([]);
  });

  it("keeps fresh chili's real substitutes (chiliflakes, sambal oelek) — the fix must not empty an innocent slot", () => {
    // The failure mode a blunt fix (deleting the group without checking what else
    // it fed) would produce: `farsk-chili` also belongs to `chili-och-hetta`, a
    // genuine interchangeable-member group, so every chili slot must keep offering
    // from that group after `asiatisk-aromatbas` is gone.
    const deadEnds: string[] = [];

    for (const found of data.templates) {
      found.ingredient_slots.forEach((slot, index) => {
        if (slot.ingredient_id !== "farsk-chili") return;
        const offers = substituteCandidateIds(data, found.cuisine, slot.role, slot.ingredient_id);
        if (offers.length === 0) deadEnds.push(`${found.name} [${index}]`);
      });
    }

    expect(deadEnds).toEqual([]);
  });
});
