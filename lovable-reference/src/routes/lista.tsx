import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { Screen } from "@/components/matmatch/Screen";
import { Button } from "@/components/ui/button";
import { useHousehold } from "@/lib/matmatch/store";
import { INGREDIENT_MAP, RECIPE_MAP } from "@/lib/matmatch/data";
import { portionFactor, scaledAmount, splitShopping } from "@/lib/matmatch/engine";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/lista")({
  head: () => ({
    meta: [
      { title: "Inköpslista — Matmatch" },
      {
        name: "description",
        content: "En kort inköpslista för kvällens middag, uppdelad i vad du har hemma och vad du behöver köpa.",
      },
      { property: "og:title", content: "Inköpslista — Matmatch" },
      { property: "og:description", content: "Vad du har hemma och vad du behöver köpa." },
    ],
  }),
  component: ShoppingList,
});

function ShoppingList() {
  const { state, hydrated, toggleBought } = useHousehold();
  const navigate = useNavigate();
  const recipe = state.chosenRecipeId ? RECIPE_MAP[state.chosenRecipeId] : undefined;

  if (!hydrated) return <Screen eyebrow="Inköpslista" title="Laddar…">{null}</Screen>;

  if (!recipe) {
    return (
      <Screen eyebrow="Inköpslista">
        <div className="mt-6 rounded-2xl border border-dashed border-border bg-card/60 p-7 text-center">
          <h1 className="text-2xl leading-snug">Ingen middag vald ännu</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Välj kvällens middag så delar vi upp listan i vad du redan har hemma och vad du behöver
            handla.
          </p>
          <Button className="mt-6 w-full rounded-2xl" onClick={() => navigate({ to: "/" })}>
            Se förslag för ikväll
          </Button>
        </div>
      </Screen>
    );
  }

  const factor = portionFactor(state.members);
  const { haves, needs } = splitShopping(recipe, state.pantry);

  return (
    <Screen eyebrow="Inköpslista" title={recipe.name}>
      <p className="-mt-3 text-[13px] text-muted-foreground">
        Mängder för {state.members.length} personer i hushållet.
      </p>

      <section className="mt-8">
        <p className="text-eyebrow">Behöver handlas</p>
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
          {needs.map((item) => {
            const done = state.bought.includes(item.id);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => toggleBought(item.id)}
                  className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
                >
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-full border",
                      done ? "border-primary bg-primary" : "border-border",
                    )}
                  >
                    {done && <Check className="size-3 text-primary-foreground" strokeWidth={3} />}
                  </span>
                  <span
                    className={cn(
                      "flex-1 text-[15px]",
                      done && "text-muted-foreground line-through",
                    )}
                  >
                    {INGREDIENT_MAP[item.id]?.name}
                  </span>
                  <span className="text-[13px] text-muted-foreground">
                    {scaledAmount(item, factor).text}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mt-8">
        <p className="text-eyebrow">Har hemma</p>
        <ul className="mt-3 space-y-2.5">
          {haves.map((item) => (
            <li key={item.id} className="flex items-center justify-between text-[15px]">
              <span className="text-muted-foreground">{INGREDIENT_MAP[item.id]?.name}</span>
              <span className="text-[13px] text-muted-foreground/70">
                {scaledAmount(item, factor).text}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <Button
        className="mt-10 h-13 w-full rounded-2xl py-4"
        onClick={() => navigate({ to: "/laga/$id", params: { id: recipe.id } })}
      >
        Till matlagningen
      </Button>
    </Screen>
  );
}
