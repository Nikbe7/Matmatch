import type { Cuisine, IngredientSlotRole, PrepTimeBand } from "../schema/recipeTemplate.js";

// The full Tier 1 prompt lives in this one module so its token cost is visible in one
// place (CLAUDE.md, "keep the prompt in one module as a template string"). Nothing
// else in src/ai/ builds prompt text.
//
// The two rules that carry real consequence — only these ingredients, and no
// amounts — are also enforced deterministically after generation
// (instructionsValidation.ts, #154). Asking for them here is what makes the
// enforcement rarely fire; it is not what makes it safe.
//
// Deliberately excluded from the input, per issue #78 and ARCHITECTURE.md §4.2's
// "minimal context per call": the ingredient catalog (only the resolved Swedish
// names + roles for *this* dish), household data (dietary flags,
// portions), and any cost figure. The model never sees enough to invent a household
// fact or a price.

export interface InstructionsPromptIngredient {
  role: IngredientSlotRole;
  name: string;
}

export interface InstructionsPromptInput {
  dishName: string;
  cuisine: Cuisine;
  prepTimeBand: PrepTimeBand;
  ingredients: readonly InstructionsPromptIngredient[];
}

const ROLE_LABELS: Record<IngredientSlotRole, string> = {
  protein: "protein",
  starch: "stärkelse",
  vegetable: "grönsak",
  aromatic: "arom",
  dairy: "mejeri",
};

export function buildInstructionsPrompt(input: InstructionsPromptInput): string {
  const ingredientLines = input.ingredients
    .map((ingredient) => `- ${ingredient.name} (${ROLE_LABELS[ingredient.role]})`)
    .join("\n");

  return `Du skriver korta, tydliga tillagningssteg på svenska för en hemmakock.

Rätt: ${input.dishName}
Kök: ${input.cuisine}
Tillagningstid: ${input.prepTimeBand}
Ingredienser:
${ingredientLines}

Skriv 6–10 korta steg som beskriver hur rätten lagas till, i ordning.

Regler:
- Svenska, korta meningar, ett steg per handling.
- Använd enbart ingredienserna ovan. Nämn aldrig en ingrediens som inte står i listan — inte heller grädde, ost, nötter, buljong eller något annat du tycker skulle passa.
- Inga mängder eller vikter (ingredienslistan har inga mängder — hitta inte på några). Skriv "tillsätt grädden", aldrig "tillsätt 2 dl grädde".
- Inga prisuppgifter eller kronbelopp.
- Tider och temperaturer är tillåtna när tillagningstiden ovan stöder det (t.ex. "stek tills den fått färg" eller "grädda i ugnen på 200 grader" är bägge okej).
- Räkna inte upp ingredienserna på nytt, ge inga serveringsförslag, ingen näringsinformation och inga extra tips.
- Svara enbart med steg-listan, inget annat.`;
}
