import { describe, expect, it } from "vitest";
import type { SlotQuantity } from "../schema/recipeTemplate.js";
import { REFERENCE_PORTIONS, scaleSlotQuantity } from "./quantities.js";

// #123. These assert the rounding rule itself, not just that scaling happens: the
// whole reason quantities are worth showing is that the number on the list is one a
// person can buy and measure, so "600 g at 3 portions is 450 g" is the contract, and
// "450.00000001 g" or "137 g" would be a regression even though both are arithmetically
// closer to the linear value.

function grams(amount: number): SlotQuantity {
  return { kind: "amount", amount, unit: "g" };
}

describe("scaleSlotQuantity — linear scaling against the reference count", () => {
  it("returns the authored amount at exactly the reference portion count", () => {
    expect(scaleSlotQuantity(grams(600), REFERENCE_PORTIONS)).toEqual(grams(600));
  });

  it("halves at half the reference count and doubles at twice it", () => {
    expect(scaleSlotQuantity(grams(600), 2)).toEqual(grams(300));
    expect(scaleSlotQuantity(grams(600), 8)).toEqual(grams(1200));
  });

  it("scales a fractional household total — two adults and a child", () => {
    // portion_factor 1 + 1 + 0.7: the everyday case, and the one that would produce
    // "405 g" without a rounding rule.
    expect(scaleSlotQuantity(grams(600), 2.7)).toEqual(grams(400));
  });

  it("scales for a single diner", () => {
    expect(scaleSlotQuantity(grams(600), 1)).toEqual(grams(150));
  });
});

describe("scaleSlotQuantity — rounding rule per unit", () => {
  it("rounds grams below 100 to the nearest 10", () => {
    // 100 g at 1.3 portions is 32.5 g linear.
    expect(scaleSlotQuantity(grams(100), 1.3)).toEqual(grams(30));
    expect(scaleSlotQuantity(grams(100), 1.4)).toEqual(grams(40));
  });

  it("rounds grams at or above 100 to the nearest 50", () => {
    // 500 g at 1.1 portions is 137.5 g linear — the number the rule exists to prevent.
    expect(scaleSlotQuantity(grams(500), 1.1)).toEqual(grams(150));
    expect(scaleSlotQuantity(grams(700), 2.7)).toEqual(grams(450));
  });

  it("picks the band from the scaled value, so an amount just under 100 g rounds by 10", () => {
    // 128 g at 3 portions is 96 g linear: the fine band applies, nearest 10 is 100,
    // and the value must not be pulled into the coarse band by its own result.
    expect(scaleSlotQuantity(grams(128), 3)).toEqual(grams(100));
    // 124 g linear sits just over the boundary and rounds by 50, down to 100.
    expect(scaleSlotQuantity(grams(496), REFERENCE_PORTIONS / 4)).toEqual(grams(100));
  });

  it("rounds dl, msk and tsk to the nearest half", () => {
    expect(scaleSlotQuantity({ kind: "amount", amount: 2, unit: "dl" }, 3)).toEqual({
      kind: "amount",
      amount: 1.5,
      unit: "dl",
    });
    // 3 msk at 2.7 portions is 2.025 — a third of a tablespoon is not a measurement.
    expect(scaleSlotQuantity({ kind: "amount", amount: 3, unit: "msk" }, 2.7)).toEqual({
      kind: "amount",
      amount: 2,
      unit: "msk",
    });
    expect(scaleSlotQuantity({ kind: "amount", amount: 1, unit: "tsk" }, 3)).toEqual({
      kind: "amount",
      amount: 1,
      unit: "tsk",
    });
  });

  it("rounds counted units to whole numbers — never half an egg", () => {
    expect(scaleSlotQuantity({ kind: "amount", amount: 4, unit: "st" }, 2.7)).toEqual({
      kind: "amount",
      amount: 3,
      unit: "st",
    });
    expect(scaleSlotQuantity({ kind: "amount", amount: 3, unit: "klyfta" }, 6)).toEqual({
      kind: "amount",
      amount: 5,
      unit: "klyfta",
    });
    expect(scaleSlotQuantity({ kind: "amount", amount: 1, unit: "kruka" }, 8)).toEqual({
      kind: "amount",
      amount: 2,
      unit: "kruka",
    });
  });

  it("rounds krm to whole — a kryddmått is the smallest thing measured", () => {
    expect(scaleSlotQuantity({ kind: "amount", amount: 2, unit: "krm" }, 2.7)).toEqual({
      kind: "amount",
      amount: 1,
      unit: "krm",
    });
    expect(scaleSlotQuantity({ kind: "amount", amount: 2, unit: "krm" }, 6)).toEqual({
      kind: "amount",
      amount: 3,
      unit: "krm",
    });
  });

  it("never scales an amount away to nothing", () => {
    // Every unit has a floor: a one-portion dish still needs some garlic in it.
    expect(scaleSlotQuantity(grams(20), 0.5)).toEqual(grams(10));
    expect(scaleSlotQuantity({ kind: "amount", amount: 1, unit: "klyfta" }, 0.5)).toEqual({
      kind: "amount",
      amount: 1,
      unit: "klyfta",
    });
    expect(scaleSlotQuantity({ kind: "amount", amount: 0.5, unit: "dl" }, 0.5)).toEqual({
      kind: "amount",
      amount: 0.5,
      unit: "dl",
    });
    expect(scaleSlotQuantity({ kind: "amount", amount: 1, unit: "krm" }, 0.5)).toEqual({
      kind: "amount",
      amount: 1,
      unit: "krm",
    });
  });

  it("produces amounts free of floating-point residue at every portion count", () => {
    const units = ["g", "dl", "msk", "tsk", "krm", "st", "klyfta", "kruka"] as const;
    for (const unit of units) {
      for (let portions = 0.5; portions <= 12; portions += 0.1) {
        const scaled = scaleSlotQuantity({ kind: "amount", amount: 3, unit }, portions);
        if (scaled.kind !== "amount") throw new Error("expected an amount");
        // Either a whole number or a clean half — nothing with a tail.
        expect(Number.isInteger(scaled.amount * 2)).toBe(true);
        expect(scaled.amount).toBeGreaterThan(0);
      }
    }
  });
});

describe("scaleSlotQuantity — to_taste and defensive inputs", () => {
  it("leaves to_taste alone at every portion count — salt is salt", () => {
    for (const portions of [0.5, 1, 2.7, 4, 12]) {
      expect(scaleSlotQuantity({ kind: "to_taste" }, portions)).toEqual({ kind: "to_taste" });
    }
  });

  it("falls back to the authored amount rather than throwing on a nonsense portion count", () => {
    // A shopping list showing reference amounts beats one that fails to render; the
    // engine has no opinion about how a caller reached this.
    expect(scaleSlotQuantity(grams(600), 0)).toEqual(grams(600));
    expect(scaleSlotQuantity(grams(600), -3)).toEqual(grams(600));
    expect(scaleSlotQuantity(grams(600), Number.NaN)).toEqual(grams(600));
    expect(scaleSlotQuantity(grams(600), Number.POSITIVE_INFINITY)).toEqual(grams(600));
  });
});
