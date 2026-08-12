import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { HouseholdState, Member, Weights } from "./types";

const STORAGE_KEY = "matmatch.household.v1";

export const DEFAULT_STATE: HouseholdState = {
  members: [
    { id: "m1", name: "Niklas", kind: "adult", allergies: [], diet: [] },
    { id: "m2", name: "Sara", kind: "adult", allergies: [], diet: [] },
    { id: "m3", name: "Ella", kind: "child", allergies: [], diet: [] },
  ],
  weights: { price: 60, time: 70, variation: 40, simple: 55 },
  pantry: ["pasta", "lok", "ris"],
  chosenRecipeId: null,
  history: [
    { recipeId: "tacos", at: new Date(Date.now() - 1 * 86_400_000).toISOString() },
    { recipeId: "kottfarssas", at: new Date(Date.now() - 4 * 86_400_000).toISOString() },
    { recipeId: "krämig-kokoscurry", at: new Date(Date.now() - 9 * 86_400_000).toISOString() },
  ],
  bought: [],
};

type Ctx = {
  state: HouseholdState;
  hydrated: boolean;
  setWeights: (patch: Partial<Weights>) => void;
  togglePantry: (id: string) => void;
  clearPantry: () => void;
  setMembers: (members: Member[]) => void;
  chooseRecipe: (id: string | null) => void;
  markCooked: (id: string) => void;
  toggleBought: (id: string) => void;
  reset: () => void;
};

const HouseholdContext = createContext<Ctx | null>(null);

export function HouseholdProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<HouseholdState>(DEFAULT_STATE);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setState({ ...DEFAULT_STATE, ...(JSON.parse(raw) as HouseholdState) });
    } catch {
      /* ignorera trasig lagring */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignorera */
    }
  }, [state, hydrated]);

  const patch = useCallback(
    (fn: (s: HouseholdState) => HouseholdState) => setState((s) => fn(s)),
    [],
  );

  const value = useMemo<Ctx>(
    () => ({
      state,
      hydrated,
      setWeights: (p) => patch((s) => ({ ...s, weights: { ...s.weights, ...p } })),
      togglePantry: (id) =>
        patch((s) => ({
          ...s,
          pantry: s.pantry.includes(id) ? s.pantry.filter((x) => x !== id) : [...s.pantry, id],
        })),
      clearPantry: () => patch((s) => ({ ...s, pantry: [] })),
      setMembers: (members) => patch((s) => ({ ...s, members })),
      chooseRecipe: (id) => patch((s) => ({ ...s, chosenRecipeId: id, bought: [] })),
      markCooked: (id) =>
        patch((s) => ({
          ...s,
          chosenRecipeId: null,
          bought: [],
          history: [{ recipeId: id, at: new Date().toISOString() }, ...s.history].slice(0, 30),
        })),
      toggleBought: (id) =>
        patch((s) => ({
          ...s,
          bought: s.bought.includes(id) ? s.bought.filter((x) => x !== id) : [...s.bought, id],
        })),
      reset: () => setState(DEFAULT_STATE),
    }),
    [state, hydrated, patch],
  );

  return <HouseholdContext.Provider value={value}>{children}</HouseholdContext.Provider>;
}

export function useHousehold() {
  const ctx = useContext(HouseholdContext);
  if (!ctx) throw new Error("useHousehold måste användas inom HouseholdProvider");
  return ctx;
}
