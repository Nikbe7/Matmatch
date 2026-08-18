import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCookRecords,
  loadCookRecord,
  loadLatestCookRecord,
  saveCookRecord,
  substitutionKey,
  type CookRecord,
} from "./instructionsStorage";

function record(overrides: Partial<CookRecord> = {}): CookRecord {
  return {
    version: 1,
    templateId: "kycklinggryta",
    substitutionKey: substitutionKey([]),
    substitutions: [],
    name: "Kycklinggryta",
    prepTimeBand: "20-40min",
    ingredients: [{ name: "Kycklingfilé", quantity: { kind: "amount", amount: 400, unit: "g" } }],
    steps: ["Ett.", "Två.", "Tre.", "Fyra.", "Fem.", "Sex."],
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("substitutionKey", () => {
  it("is stable regardless of the order substitutions arrive in", () => {
    const a = substitutionKey([
      { slot_index: 2, substitute_ingredient_id: "morot" },
      { slot_index: 0, substitute_ingredient_id: "tofu" },
    ]);
    const b = substitutionKey([
      { slot_index: 0, substitute_ingredient_id: "tofu" },
      { slot_index: 2, substitute_ingredient_id: "morot" },
    ]);

    expect(a).toBe(b);
  });

  it("keys two different substitution sets differently", () => {
    expect(substitutionKey([{ slot_index: 0, substitute_ingredient_id: "tofu" }])).not.toBe(
      substitutionKey([{ slot_index: 0, substitute_ingredient_id: "kyckling" }]),
    );
  });

  it("matches the server's format, so the two caches agree on what one dish is", () => {
    // Mirrors buildSubstitutionKey in src/db/recipeInstructions.ts — sorted
    // "slot_index:ingredient_id" pairs. Portions are absent from both, by design.
    expect(
      substitutionKey([
        { slot_index: 1, substitute_ingredient_id: "tofu" },
        { slot_index: 0, substitute_ingredient_id: "morot" },
      ]),
    ).toBe("0:morot,1:tofu");
  });
});

describe("cook records", () => {
  it("round-trips a record", () => {
    saveCookRecord(record());
    expect(loadCookRecord("kycklinggryta", [])?.steps).toEqual(record().steps);
  });

  it("does not serve one substitution set's steps for another's", () => {
    const swapped = [{ slot_index: 0, substitute_ingredient_id: "tofu" }];
    saveCookRecord(record({ substitutionKey: substitutionKey(swapped), substitutions: swapped }));

    expect(loadCookRecord("kycklinggryta", swapped)).not.toBeNull();
    expect(loadCookRecord("kycklinggryta", [])).toBeNull();
  });

  it("replaces rather than duplicates a record for the same dish and swaps", () => {
    saveCookRecord(record());
    saveCookRecord(record({ steps: ["Nya steg.", "Två.", "Tre.", "Fyra.", "Fem.", "Sex."] }));

    expect(loadCookRecord("kycklinggryta", [])?.steps[0]).toBe("Nya steg.");
  });

  it("keeps the five most recent dishes and evicts beyond that", () => {
    for (let i = 0; i < 7; i++) saveCookRecord(record({ templateId: `dish-${i}` }));

    expect(loadLatestCookRecord("dish-6")).not.toBeNull();
    expect(loadLatestCookRecord("dish-2")).not.toBeNull();
    // The two oldest are gone — this is an offline safety net for what is being
    // cooked, not an archive.
    expect(loadLatestCookRecord("dish-0")).toBeNull();
    expect(loadLatestCookRecord("dish-1")).toBeNull();
  });

  it("finds a dish by template alone, for a cold open of /laga/:id", () => {
    const swapped = [{ slot_index: 0, substitute_ingredient_id: "tofu" }];
    saveCookRecord(record({ substitutionKey: substitutionKey(swapped), substitutions: swapped }));

    // Nothing in hand names the substitutions on a reload, so the resume path
    // recovers them from the record itself.
    expect(loadLatestCookRecord("kycklinggryta")?.substitutions).toEqual(swapped);
  });

  it("discards a malformed record instead of throwing", () => {
    localStorage.setItem("matmatch.cookInstructions", '[{"version":1,"templateId":42}]');
    expect(loadCookRecord("kycklinggryta", [])).toBeNull();
  });

  it("survives foreign JSON in the key", () => {
    localStorage.setItem("matmatch.cookInstructions", "not json at all");
    expect(loadLatestCookRecord("kycklinggryta")).toBeNull();
  });

  it("drops only the malformed entry, not the whole store", () => {
    saveCookRecord(record());
    const raw = JSON.parse(localStorage.getItem("matmatch.cookInstructions")!) as unknown[];
    localStorage.setItem("matmatch.cookInstructions", JSON.stringify([{ version: 1 }, ...raw]));

    expect(loadCookRecord("kycklinggryta", [])?.steps).toEqual(record().steps);
  });

  it("clears", () => {
    saveCookRecord(record());
    clearCookRecords();
    expect(loadCookRecord("kycklinggryta", [])).toBeNull();
  });
});
