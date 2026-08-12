import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Screen } from "@/components/matmatch/Screen";
import { Chip } from "@/components/matmatch/Chip";
import { Button } from "@/components/ui/button";
import { useHousehold } from "@/lib/matmatch/store";
import { INGREDIENT_MAP } from "@/lib/matmatch/data";
import { COST_LABEL, effortDots, rank } from "@/lib/matmatch/engine";
import type { ProteinGroup } from "@/lib/matmatch/types";

export const Route = createFileRoute("/bygg")({
  head: () => ({
    meta: [
      { title: "Bygg en middag — Matmatch" },
      {
        name: "description",
        content:
          "Välj protein och vad du har hemma. Matmatch föreslår några riktningar istället för att du ska skriva en prompt.",
      },
      { property: "og:title", content: "Bygg en middag — Matmatch" },
      {
        property: "og:description",
        content: "Bygg kvällens middag genom några enkla val.",
      },
    ],
  }),
  component: Build,
});

const PROTEINS: { id: ProteinGroup | "any"; label: string }[] = [
  { id: "chicken_poultry", label: "Kyckling" },
  { id: "beef_pork", label: "Köttfärs" },
  { id: "fish_seafood", label: "Fisk" },
  { id: "vegetarian", label: "Vegetariskt" },
  { id: "any", label: "Något annat" },
];

const BASES = ["ris", "pasta", "potatis", "gradde", "lok", "kikarter"];

function Build() {
  const { state, togglePantry, chooseRecipe } = useHousehold();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [protein, setProtein] = useState<ProteinGroup | "any" | null>(null);
  const [unknown, setUnknown] = useState(false);

  const suggestions = useMemo(() => {
    const all = rank(state);
    const filtered =
      protein && protein !== "any"
        ? all.filter((s) =>
            protein === "vegetarian"
              ? s.recipe.proteinGroup === "vegetarian" || s.recipe.proteinGroup === "vegan"
              : s.recipe.proteinGroup === protein,
          )
        : all;
    return (filtered.length ? filtered : all).slice(0, 3);
  }, [state, protein]);

  return (
    <Screen
      eyebrow={`Steg ${Math.min(step + 1, 3)} av 3`}
      title={
        step === 0 ? "Vad vill du använda?" : step === 1 ? "Vad har du hemma?" : "Tre riktningar"
      }
      action={
        step > 0 ? (
          <button
            type="button"
            onClick={() => setStep((s) => s - 1)}
            aria-label="Tillbaka"
            className="mt-1 rounded-full border border-border bg-card p-2 text-muted-foreground"
          >
            <ArrowLeft className="size-4" />
          </button>
        ) : null
      }
    >
      {step === 0 && (
        <div>
          <p className="-mt-3 mb-5 text-[14px] leading-relaxed text-muted-foreground">
            Två val räcker. Vi tar hänsyn till era allergier och vad ni lagat den senaste tiden.
          </p>
          <div className="flex flex-wrap gap-2.5">
            {PROTEINS.map((p) => (
              <Chip
                key={p.id}
                selected={protein === p.id}
                onClick={() => {
                  setProtein(p.id);
                  setStep(1);
                }}
              >
                {p.label}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {step === 1 && (
        <div>
          <div className="flex flex-wrap gap-2.5">
            {BASES.map((id) => (
              <Chip
                key={id}
                selected={state.pantry.includes(id)}
                onClick={() => {
                  setUnknown(false);
                  togglePantry(id);
                }}
              >
                {INGREDIENT_MAP[id]?.name}
              </Chip>
            ))}
            <Chip selected={unknown} onClick={() => setUnknown(true)}>
              Jag vet inte
            </Chip>
          </div>
          <Button className="mt-8 h-13 w-full rounded-2xl py-4" onClick={() => setStep(2)}>
            Visa förslag
          </Button>
          <p className="mt-3 text-center text-[13px] text-muted-foreground">
            Du behöver inte lista allt — det räcker med en ledtråd.
          </p>
        </div>
      )}

      {step === 2 && (
        <ul className="space-y-3">
          {suggestions.map((s, i) => (
            <li key={s.recipe.id}>
              <button
                type="button"
                onClick={() => {
                  chooseRecipe(s.recipe.id);
                  navigate({ to: "/laga/$id", params: { id: s.recipe.id } });
                }}
                className="w-full rounded-2xl border border-border bg-card p-5 text-left shadow-soft transition-transform active:scale-[0.99]"
                style={{ animation: `mm-rise .4s ${i * 70}ms cubic-bezier(.22,1,.36,1) both` }}
              >
                <h3 className="font-display text-[21px] leading-snug">{s.recipe.name}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
                  {s.recipe.blurb}
                </p>
                <div className="mt-3.5 flex items-center gap-2.5 text-[12px] text-muted-foreground">
                  <span>{s.recipe.prepMinutes} min</span>
                  <span className="text-border">•</span>
                  <span className="tracking-[0.15em]">{effortDots(s.recipe.effort)}</span>
                  <span className="text-border">•</span>
                  <span>{COST_LABEL[s.recipe.costTier]}</span>
                </div>
              </button>
            </li>
          ))}
          <li>
            <Button
              variant="ghost"
              className="w-full text-muted-foreground"
              onClick={() => setStep(0)}
            >
              Börja om
            </Button>
          </li>
        </ul>
      )}
    </Screen>
  );
}
