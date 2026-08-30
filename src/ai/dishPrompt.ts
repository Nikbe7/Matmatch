// Tier 2 dish-generation prompt (issue #113). Kept in one module for the same
// reason instructionsPrompt.ts is: token cost visible in one place.
//
// Deliberately excluded from the input, matching instructionsPrompt.ts's rule:
// household data (dietary flags, portions) and any cost figure. The
// model never sees enough to invent a household fact or a price, and it never
// decides whether a dish may be shown — that is entirely src/engine/generatedDish.ts's
// job, after this response comes back. The one thing this prompt sends beyond a bare
// query is the catalog's ingredient names, and only as a closed vocabulary to pick
// from — never as data the model is allowed to reinterpret.

export interface DishPromptInput {
  /** The free-text dish request, e.g. "kycklinggryta med curry". */
  query: string;
  /** Every ingredient name in the curated catalog — the model's only allowed vocabulary. */
  catalogIngredientNames: readonly string[];
}

export function buildDishPrompt(input: DishPromptInput): string {
  const catalogList = input.catalogIngredientNames.join(", ");

  return `Du hittar på en middagsrätt utifrån en sökfras, för en svensk hemmakock.

Sökfras: "${input.query}"

Tillåtna ingredienser (välj enbart från denna lista, stava exakt som här):
${catalogList}

Svara med:
- Ett kort, naturligt rättnamn på svenska.
- Kök (cuisine), tillagningstid, proteingrupp, måltidstyper och hur vardaglig rätten är, enligt det schema du fått.
- 3–8 ingredienser, var och en med en roll (protein, stärkelse, grönsak, arom eller mejeri) och ett namn hämtat ordagrant ur listan ovan.

Regler:
- Ingrediensnamnen måste vara exakta kopior från listan ovan — hitta inte på egna namn, stava inte om, och lägg inte till ord som inte står där.
- Ingen mängdangivelse, inget pris, ingen näringsinformation.
- Om sökfrasen inte tydligt beskriver en rätt: gör ditt bästa rimliga tolkning ändå — svara aldrig med en tom ingredienslista.`;
}
