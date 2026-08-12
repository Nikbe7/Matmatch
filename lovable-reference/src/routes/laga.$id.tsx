import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowLeft, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useHousehold } from "@/lib/matmatch/store";
import { INGREDIENT_MAP, RECIPE_MAP } from "@/lib/matmatch/data";
import {
  COST_LABEL,
  effortDots,
  householdLabel,
  portionFactor,
  scaledAmount,
  splitShopping,
} from "@/lib/matmatch/engine";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/laga/$id")({
  head: () => ({
    meta: [
      { title: "Laga middagen — Matmatch" },
      {
        name: "description",
        content: "Ingredienser för ditt hushåll och ett steg i taget, gjort för att följas stående i köket.",
      },
      { property: "og:title", content: "Laga middagen — Matmatch" },
      { property: "og:description", content: "Ett steg i taget, anpassat efter hushållets portioner." },
    ],
  }),
  component: Cook,
  notFoundComponent: () => <Missing />,
});

function Missing() {
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-md px-5 py-16 text-center">
      <h1 className="text-2xl">Middagen hittades inte</h1>
      <Button className="mt-6 w-full rounded-2xl" onClick={() => navigate({ to: "/" })}>
        Till ikväll
      </Button>
    </div>
  );
}

function Cook() {
  const { id } = Route.useParams();
  const { state, markCooked } = useHousehold();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [done, setDone] = useState<number[]>([]);
  const recipe = RECIPE_MAP[id];

  if (!recipe) return <Missing />;

  const factor = portionFactor(state.members);
  const { needs } = splitShopping(recipe, state.pantry);

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto w-full max-w-md px-5 pb-16 pt-6">
        <button
          type="button"
          onClick={() => navigate({ to: "/" })}
          className="flex items-center gap-1.5 text-[13px] text-muted-foreground"
        >
          <ArrowLeft className="size-4" /> Ikväll
        </button>

        <h1 className="mt-6 text-[30px] leading-[1.1]">{recipe.name}</h1>
        <div className="mt-4 flex flex-wrap items-center gap-2.5 text-[13px] text-muted-foreground">
          <span>{recipe.prepMinutes} min</span>
          <span className="text-border">•</span>
          <span className="tracking-[0.15em]">{effortDots(recipe.effort)}</span>
          <span className="text-border">•</span>
          <span>{COST_LABEL[recipe.costTier]}</span>
          <span className="text-border">•</span>
          <span>{householdLabel(state.members)}</span>
        </div>

        <section className="mt-8 rounded-2xl border border-border bg-card p-5 shadow-soft">
          <p className="text-eyebrow">Ingredienser</p>
          <ul className="mt-3.5 space-y-2.5">
            {recipe.ingredients.map((item) => (
              <li key={item.id} className="flex items-baseline justify-between gap-4 text-[15px]">
                <span>{INGREDIENT_MAP[item.id]?.name}</span>
                <span className="shrink-0 text-[13px] text-muted-foreground">
                  {scaledAmount(item, factor).text}
                </span>
              </li>
            ))}
          </ul>
          {needs.length > 0 && (
            <button
              type="button"
              onClick={() => navigate({ to: "/lista" })}
              className="mt-4 text-[13px] font-medium text-primary"
            >
              {needs.length} saker att handla →
            </button>
          )}
        </section>

        <section className="mt-9">
          <p className="text-eyebrow">Så gör du</p>
          <ol className="mt-4 space-y-2.5">
            {recipe.steps.map((text, i) => {
              const active = i === step;
              const complete = done.includes(i);
              return (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => setStep(i)}
                    className={cn(
                      "flex w-full gap-4 rounded-2xl border p-4 text-left transition-colors",
                      active
                        ? "border-foreground/15 bg-card shadow-soft"
                        : "border-transparent bg-surface/70",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[12px] font-medium",
                        complete
                          ? "bg-primary text-primary-foreground"
                          : active
                            ? "bg-foreground text-background"
                            : "bg-border/60 text-muted-foreground",
                      )}
                    >
                      {complete ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
                    </span>
                    <span
                      className={cn(
                        "text-[16px] leading-relaxed",
                        active ? "text-foreground" : "text-muted-foreground",
                        complete && "line-through",
                      )}
                    >
                      {text}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          {step < recipe.steps.length - 1 ? (
            <Button
              className="mt-7 h-13 w-full rounded-2xl py-4"
              onClick={() => {
                setDone((d) => [...new Set([...d, step])]);
                setStep((s) => s + 1);
              }}
            >
              Klar med steg {step + 1}
            </Button>
          ) : (
            <Button
              className="mt-7 h-13 w-full rounded-2xl py-4 shadow-lift"
              onClick={() => {
                markCooked(recipe.id);
                navigate({ to: "/" });
              }}
            >
              Middagen är klar
            </Button>
          )}
        </section>
      </div>
    </div>
  );
}
