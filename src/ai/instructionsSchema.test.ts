import { describe, expect, it } from "vitest";
import { GeneratedInstructionsSchema } from "./instructionsSchema.js";

const sixSteps = [
  "Skär kycklingen i bitar.",
  "Skala och tärna moroten.",
  "Hetta upp olja i en gryta.",
  "Bryn kycklingen på hög värme.",
  "Tillsätt moroten och fräs kort.",
  "Låt allt sjuda tills kycklingen är genomstekt.",
];

describe("GeneratedInstructionsSchema", () => {
  it("accepts 6-10 short Swedish steps", () => {
    expect(GeneratedInstructionsSchema.safeParse({ steps: sixSteps }).success).toBe(true);
  });

  it("rejects fewer than 6 steps", () => {
    expect(GeneratedInstructionsSchema.safeParse({ steps: sixSteps.slice(0, 3) }).success).toBe(false);
  });

  it("rejects more than 10 steps", () => {
    const eleven = [...sixSteps, ...sixSteps.slice(0, 5)];
    expect(GeneratedInstructionsSchema.safeParse({ steps: eleven }).success).toBe(false);
  });

  it.each([
    ["saves 15 kr", ["saves 15 kr", ...sixSteps.slice(1)]],
    ["kostar 20kr extra", ["kostar 20kr extra", ...sixSteps.slice(1)]],
    ["för 45 kronor", ["för 45 kronor", ...sixSteps.slice(1)]],
    ["ca 30 SEK billigare", ["ca 30 SEK billigare", ...sixSteps.slice(1)]],
  ])("rejects a response containing a currency string (%s)", (_label, steps) => {
    expect(GeneratedInstructionsSchema.safeParse({ steps }).success).toBe(false);
  });

  it("allows oven temperatures and times, which are not currency figures", () => {
    const withTempAndTime = [
      "Sätt ugnen på 200 grader.",
      "Bryn köttfärsen i 6 minuter.",
      ...sixSteps.slice(2),
    ];
    expect(GeneratedInstructionsSchema.safeParse({ steps: withTempAndTime }).success).toBe(true);
  });

  it("does not false-positive on Swedish words that merely contain 'kr'", () => {
    const withKryddor = ["Tillsätt kryddor och krossade tomater.", ...sixSteps.slice(1)];
    expect(GeneratedInstructionsSchema.safeParse({ steps: withKryddor }).success).toBe(true);
  });
});
