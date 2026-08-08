import { describe, expect, it } from "vitest";
import { ALLERGIES } from "../../src/schema/vocabulary";
import { allergyExclusionReason, capitalizeForSentence } from "./allergyLabels";

describe("allergyExclusionReason", () => {
  it("names every allergy in the locked vocabulary — not a sample", () => {
    expect(allergyExclusionReason(["gluten"])).toBe("glutenallergi");
    expect(allergyExclusionReason(["dairy_lactose"])).toBe("laktosallergi");
    expect(allergyExclusionReason(["egg"])).toBe("äggallergi");
    expect(allergyExclusionReason(["tree_nuts"])).toBe("trädnötsallergi");
    expect(allergyExclusionReason(["peanuts"])).toBe("jordnötsallergi");
    expect(allergyExclusionReason(["shellfish"])).toBe("skaldjursallergi");
    expect(allergyExclusionReason(["fish"])).toBe("fiskallergi");
    expect(allergyExclusionReason(["soy"])).toBe("sojaallergi");
  });

  it("covers every value ALLERGIES actually has, so a ninth value cannot go unlabeled silently", () => {
    for (const allergy of ALLERGIES) {
      expect(allergyExclusionReason([allergy])).toMatch(/allergi$/);
    }
  });

  it("joins more than one allergy with 'och', matching the server's Swedish list style", () => {
    expect(allergyExclusionReason(["fish", "shellfish"])).toBe("fiskallergi och skaldjursallergi");
  });
});

describe("capitalizeForSentence", () => {
  it("capitalizes the first letter of a lowercase catalog name", () => {
    expect(capitalizeForSentence("lax")).toBe("Lax");
  });

  it("leaves an already-capitalized name unchanged", () => {
    expect(capitalizeForSentence("Lax")).toBe("Lax");
  });

  it("handles an empty string without throwing", () => {
    expect(capitalizeForSentence("")).toBe("");
  });
});
