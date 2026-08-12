export type Allergen =
  | "gluten"
  | "dairy"
  | "egg"
  | "nuts"
  | "peanuts"
  | "shellfish"
  | "fish"
  | "soy";

export const ALLERGEN_LABELS: Record<Allergen, string> = {
  gluten: "Gluten",
  dairy: "Mjölk / laktos",
  egg: "Ägg",
  nuts: "Nötter",
  peanuts: "Jordnötter",
  shellfish: "Skaldjur",
  fish: "Fisk",
  soy: "Soja",
};

export type DietPreference = "vegetarian" | "vegan" | "high_protein";

export const DIET_LABELS: Record<DietPreference, string> = {
  vegetarian: "Vegetariskt",
  vegan: "Veganskt",
  high_protein: "Mycket protein",
};

export type ProteinGroup =
  | "chicken_poultry"
  | "beef_pork"
  | "fish_seafood"
  | "vegetarian"
  | "vegan";

export const PROTEIN_LABELS: Record<ProteinGroup, string> = {
  chicken_poultry: "Kyckling",
  beef_pork: "Köttfärs & kött",
  fish_seafood: "Fisk",
  vegetarian: "Vegetariskt",
  vegan: "Veganskt",
};

export type Category =
  | "protein"
  | "carb"
  | "vegetable"
  | "dairy"
  | "pantry"
  | "spice";

export type Ingredient = {
  id: string;
  name: string;
  category: Category;
  /** 1 = billig, 2 = mellan, 3 = dyr */
  costTier: 1 | 2 | 3;
  allergens: Allergen[];
  /** true om ingrediensen är av animaliskt ursprung (kött/fisk) */
  meat?: boolean;
  animal?: boolean;
};

export type Unit = "g" | "st" | "dl" | "msk" | "tsk" | "krm" | "klyfta";

export type RecipeIngredient = {
  id: string;
  /** mängd per portion (vuxen) */
  per: number;
  unit: Unit;
  note?: string;
};

export type Recipe = {
  id: string;
  name: string;
  blurb: string;
  proteinGroup: ProteinGroup;
  cuisine: string;
  /** 1 = billigt, 2 = mellan, 3 = dyrare */
  costTier: 1 | 2 | 3;
  prepMinutes: number;
  /** 1 = mycket enkelt, 3 = kräver pyssel */
  effort: 1 | 2 | 3;
  familiarity: "everyday" | "weekend" | "new";
  proteinRich: boolean;
  ingredients: RecipeIngredient[];
  steps: string[];
};

export type Member = {
  id: string;
  name: string;
  kind: "adult" | "child";
  allergies: Allergen[];
  diet: DietPreference[];
};

export type Weights = {
  price: number;
  time: number;
  variation: number;
  simple: number;
};

export type CookedMeal = { recipeId: string; at: string };

export type HouseholdState = {
  members: Member[];
  weights: Weights;
  pantry: string[];
  chosenRecipeId: string | null;
  history: CookedMeal[];
  bought: string[];
};
