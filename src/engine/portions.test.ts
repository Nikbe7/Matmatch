import { describe, expect, it } from "vitest";
import { totalPortions } from "./portions.js";

describe("totalPortions", () => {
  it("sums portion_factor across adults only", () => {
    const members = [
        { type: "adult" as const, portion_factor: 1 },
        { type: "adult" as const, portion_factor: 1 },
    ];

    expect(totalPortions(members)).toBe(2);
  });

  it("sums portion_factor across a household including a child at portion_factor 0.5", () => {
    const members = [
        { type: "adult" as const, portion_factor: 1 },
        { type: "adult" as const, portion_factor: 1 },
        { type: "child" as const, portion_factor: 0.5 },
    ];

    expect(totalPortions(members)).toBe(2.5);
  });

  it("sums portion_factor to a non-whole, non-half total for an uneven household", () => {
    const members = [
        { type: "adult" as const, portion_factor: 1 },
        { type: "adult" as const, portion_factor: 1 },
        { type: "child" as const, portion_factor: 0.3 },
    ];

    expect(totalPortions(members)).toBeCloseTo(2.3);
  });
});
