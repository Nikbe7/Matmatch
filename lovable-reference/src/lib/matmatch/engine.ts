import { INGREDIENT_MAP, RECIPES } from "./data";
import type {
  Allergen,
  HouseholdState,
  Member,
  Recipe,
  RecipeIngredient,
  Weights,
} from "./types";

/* ---------- deterministisk hushållsmatematik ---------- */

export const PORTION_FACTOR = { adult: 1, child: 0.6 } as const;

export function portionFactor(members: Member[]): number {
  const sum = members.reduce((acc, m) => acc + PORTION_FACTOR[m.kind], 0);
  return Math.max(sum, 1);
}

export function householdLabel(members: Member[]): string {
  const adults = members.filter((m) => m.kind === "adult").length;
  const children = members.filter((m) => m.kind === "child").length;
  const parts: string[] = [];
  if (adults) parts.push(`${adults} ${adults === 1 ? "vuxen" : "vuxna"}`);
  if (children) parts.push(`${children} barn`);
  return parts.join(" + ") || "1 vuxen";
}

/* ---------- allergener: hård, deterministisk filtrering ---------- */

export function recipeAllergens(recipe: Recipe): Allergen[] {
  const set = new Set<Allergen>();
  for (const item of recipe.ingredients) {
    for (const a of INGREDIENT_MAP[item.id]?.allergens ?? []) set.add(a);
  }
  return [...set];
}

export function householdAllergies(members: Member[]): Allergen[] {
  return [...new Set(members.flatMap((m) => m.allergies))];
}

/** Hård uteslutning. AI är aldrig inblandad här. */
export function isSafeForHousehold(recipe: Recipe, members: Member[]): boolean {
  const blocked = new Set(householdAllergies(members));
  if (blocked.size === 0) return true;
  return recipeAllergens(recipe).every((a) => !blocked.has(a));
}

function containsMeat(recipe: Recipe): boolean {
  return recipe.ingredients.some((i) => INGREDIENT_MAP[i.id]?.meat);
}

function containsAnimal(recipe: Recipe): boolean {
  return recipe.ingredients.some((i) => INGREDIENT_MAP[i.id]?.animal);
}

/* ---------- portioner ---------- */

function roundNice(value: number, unit: string): number {
  if (unit === "g") return Math.round(value / 5) * 5;
  if (unit === "st" || unit === "klyfta") return Math.round(value * 2) / 2;
  return Math.round(value * 4) / 4;
}

export function scaledAmount(item: RecipeIngredient, factor: number) {
  if (INGREDIENT_MAP[item.id]?.category === "spice") {
    return { value: 0, text: "efter smak" };
  }
  const raw = item.per * factor;
  const value = roundNice(raw, item.unit);
  const shown = value < 0.25 ? 0.25 : value;
  const text = Number.isInteger(shown) ? `${shown}` : `${shown}`.replace(".", ",");
  return { value: shown, text: `${text} ${item.unit}` };
}

/* ---------- rekommendationsmotor ---------- */

export const COST_LABEL = ["", "Billigt", "Mellan", "Lite dyrare"] as const;

export function timeBand(minutes: number): string {
  if (minutes <= 20) return "under 20 min";
  if (minutes <= 40) return "20–40 min";
  return "45 min +";
}

export function effortDots(effort: number): string {
  return ["", "●○○", "●●○", "●●●"][effort] ?? "●●○";
}

function daysSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

export type Scored = {
  recipe: Recipe;
  score: number;
  pantryHits: string[];
  reasons: string[];
};

export function rank(state: HouseholdState): Scored[] {
  const { members, weights, pantry, history } = state;
  const w = normalize(weights);
  const vegetarian = members.some((m) => m.diet.includes("vegetarian"));
  const vegan = members.some((m) => m.diet.includes("vegan"));
  const wantsProtein = members.some((m) => m.diet.includes("high_protein"));
  const pantrySet = new Set(pantry);

  const scored = RECIPES.filter((r) => isSafeForHousehold(r, members)).map((recipe) => {
    const reasons: string[] = [];
    let score = 1;

    // Pris som vikt, inte filter
    const priceTerm = ((3 - recipe.costTier) / 2) * 1.6 * w.price;
    score += priceTerm;
    if (w.price > 0.6 && recipe.costTier === 1) reasons.push("den håller nere kostnaden");

    // Tid som vikt
    const timeNorm = Math.min(Math.max((recipe.prepMinutes - 15) / 35, 0), 1);
    score += (1 - timeNorm) * 1.6 * w.time;
    if (w.time > 0.6 && recipe.prepMinutes <= 25) reasons.push("den går snabbt");

    // Enkelt
    score += ((3 - recipe.effort) / 2) * 1.2 * w.simple;
    if (w.simple > 0.6 && recipe.effort === 1) reasons.push("den kräver minimalt pyssel");

    // Variation
    if (recipe.familiarity === "new") {
      score += 1.5 * w.variation - 0.5 * (1 - w.variation);
      if (w.variation > 0.5) reasons.push("den är något nytt för er");
    } else if (recipe.familiarity === "everyday") {
      score += 0.4 * (1 - w.variation);
    }

    // Skafferi
    const pantryHits = recipe.ingredients.map((i) => i.id).filter((id) => pantrySet.has(id));
    if (pantryHits.length) {
      score += Math.min(pantryHits.length, 4) * 0.55;
      const names = pantryHits.map((id) => INGREDIENT_MAP[id]?.name.toLowerCase());
      reasons.unshift(`du har ${names.slice(0, 2).join(" och ")} hemma`);
    }

    // Mjuka kostpreferenser
    if (vegan && containsAnimal(recipe)) score -= 4;
    else if (vegetarian && containsMeat(recipe)) score -= 3;
    else if ((vegan || vegetarian) && !containsMeat(recipe)) reasons.push("den passar hushållets kost");
    if (wantsProtein) score += recipe.proteinRich ? 0.7 : -0.5;

    // Historik: undvik upprepning
    const last = history.find((h) => h.recipeId === recipe.id);
    if (last) {
      const days = daysSince(last.at);
      if (days < 3) score -= 5;
      else if (days < 8) score -= 2.4;
      else if (days < 16) score -= 0.9;
    }
    const sameProteinRecent = history
      .slice(0, 3)
      .some((h) => RECIPES.find((r) => r.id === h.recipeId)?.proteinGroup === recipe.proteinGroup);
    if (sameProteinRecent) score -= 0.8;

    return { recipe, score, pantryHits, reasons: reasons.slice(0, 2) };
  });

  return scored.sort((a, b) => b.score - a.score || a.recipe.name.localeCompare(b.recipe.name, "sv"));
}

function normalize(w: Weights) {
  return {
    price: w.price / 100,
    time: w.time / 100,
    variation: w.variation / 100,
    simple: w.simple / 100,
  };
}

export function reasonSentence(s: Scored): string {
  if (!s.reasons.length) return "Passar er vardag just nu.";
  const [a, b] = s.reasons;
  const text = b ? `${a} och ${b}` : a;
  return `Vald eftersom ${text}.`;
}

/* ---------- inköpslista ---------- */

export function splitShopping(recipe: Recipe, pantry: string[]) {
  const have = new Set(pantry);
  const haves: RecipeIngredient[] = [];
  const needs: RecipeIngredient[] = [];
  for (const item of recipe.ingredients) {
    (have.has(item.id) || INGREDIENT_MAP[item.id]?.category === "spice" ? haves : needs).push(item);
  }
  return { haves, needs };
}
