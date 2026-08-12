import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { Screen } from "@/components/matmatch/Screen";
import { Chip } from "@/components/matmatch/Chip";
import { PreferenceSlider } from "@/components/matmatch/PreferenceSlider";
import { Button } from "@/components/ui/button";
import { useHousehold } from "@/lib/matmatch/store";
import { INGREDIENT_MAP } from "@/lib/matmatch/data";
import {
  COST_LABEL,
  effortDots,
  householdLabel,
  rank,
  reasonSentence,
} from "@/lib/matmatch/engine";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Matmatch — Vad ska vi äta ikväll?" },
      {
        name: "description",
        content:
          "Matmatch ger ditt hushåll ett bra middagsförslag direkt, anpassat efter tid, pris, allergier och vad ni har hemma.",
      },
      { property: "og:title", content: "Matmatch — Vad ska vi äta ikväll?" },
      {
        property: "og:description",
        content: "Öppna appen, få ett bra middagsförslag, justera det, laga.",
      },
    ],
  }),
  component: Tonight,
});

const QUICK_PANTRY = ["pasta", "ris", "potatis", "gradde", "lok", "kycklingfile"];

const WEEKDAYS = ["Söndag", "Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag", "Lördag"];

function Tonight() {
  const { state, hydrated, setWeights, togglePantry, chooseRecipe } = useHousehold();
  const navigate = useNavigate();
  const [seen, setSeen] = useState<string[]>([]);
  const [openControls, setOpenControls] = useState(false);
  const [nudge, setNudge] = useState<string | null>(null);

  const ranked = useMemo(() => rank(state), [state]);
  const pick = ranked.find((s) => !seen.includes(s.recipe.id)) ?? ranked[0];

  const next = () =>
    setSeen((s) => (s.length >= ranked.length - 1 ? [] : [...s, pick?.recipe.id ?? ""]));

  if (!hydrated) return <TonightSkeleton />;

  if (!pick) {
    return (
      <Screen eyebrow="Ikväll">
        <div className="rounded-2xl border border-border bg-card p-6 text-center shadow-soft">
          <h1 className="text-2xl">Inget förslag som är säkert för er</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Era allergier utesluter alla måltider vi har just nu. Justera hushållet så hittar vi
            något igen.
          </p>
          <Button className="mt-5 w-full" onClick={() => navigate({ to: "/profil" })}>
            Öppna hushållet
          </Button>
        </div>
      </Screen>
    );
  }

  const { recipe } = pick;
  const applyNudge = (
    key: keyof typeof state.weights,
    delta: number,
    label: string,
  ) => {
    const value = Math.min(100, Math.max(0, state.weights[key] + delta));
    setWeights({ [key]: value } as never);
    next();
    setNudge(label);
  };

  return (
    <Screen>
      <div className="animate-rise">
        <p className="text-eyebrow">
          {WEEKDAYS[new Date().getDay()]} · {householdLabel(state.members)}
        </p>
        <h1 className="mt-1.5 text-[26px] leading-none text-muted-foreground">Ikväll</h1>

        <h2 className="mt-8 text-[40px] leading-[1.05] tracking-[-0.02em] text-foreground">
          {recipe.name}
        </h2>

        <div className="mt-5 flex items-center gap-3 text-[13px] text-muted-foreground">
          <span className="font-medium text-foreground">{recipe.prepMinutes} min</span>
          <span className="text-border">•</span>
          <span className="tracking-[0.15em]">{effortDots(recipe.effort)}</span>
          <span className="text-border">•</span>
          <span>{COST_LABEL[recipe.costTier]}</span>
        </div>

        <p className="mt-6 max-w-[34ch] text-[17px] leading-relaxed text-foreground/80">
          {recipe.blurb}
        </p>
        <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
          {nudge ? `${nudge} ${reasonSentence(pick)}` : reasonSentence(pick)}
        </p>

        <div className="mt-9 space-y-3">
          <Button
            size="lg"
            className="h-14 w-full rounded-2xl text-[16px] shadow-lift"
            onClick={() => {
              chooseRecipe(recipe.id);
              navigate({ to: "/laga/$id", params: { id: recipe.id } });
            }}
          >
            Laga ikväll
          </Button>
          <Button
            variant="ghost"
            size="lg"
            className="h-12 w-full rounded-2xl text-muted-foreground hover:text-foreground"
            onClick={() => {
              next();
              setNudge(null);
            }}
          >
            <RefreshCw className="mr-2 size-4" strokeWidth={1.8} />
            Byt förslag
          </Button>
        </div>
      </div>

      <section className="mt-12">
        <p className="text-eyebrow">Justera</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Chip size="sm" onClick={() => applyNudge("price", 20, "Billigare håll.")}>
            Billigare
          </Chip>
          <Chip size="sm" onClick={() => applyNudge("time", 20, "Mindre tid.")}>
            Snabbare
          </Chip>
          <Chip size="sm" onClick={() => applyNudge("variation", 25, "Något nytt.")}>
            Testa nytt
          </Chip>
          <Chip size="sm" onClick={() => applyNudge("simple", 20, "Enklare.")}>
            Enklare
          </Chip>
        </div>
      </section>

      <section className="mt-8">
        <p className="text-eyebrow">Vad har du hemma?</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {QUICK_PANTRY.map((id) => (
            <Chip
              key={id}
              size="sm"
              selected={state.pantry.includes(id)}
              onClick={() => togglePantry(id)}
            >
              {INGREDIENT_MAP[id]?.name}
            </Chip>
          ))}
        </div>
      </section>

      <section className="mt-10 rounded-2xl border border-border bg-card px-5 shadow-soft">
        <button
          type="button"
          className="flex w-full items-center justify-between py-4 text-left"
          onClick={() => setOpenControls((o) => !o)}
          aria-expanded={openControls}
        >
          <span className="text-[15px] font-medium">Vad är viktigt för er?</span>
          <ChevronDown
            className={`size-4 text-muted-foreground transition-transform ${openControls ? "rotate-180" : ""}`}
          />
        </button>
        {openControls && (
          <div className="divide-y divide-border pb-2">
            <PreferenceSlider
              label="Pris"
              value={state.weights.price}
              onChange={(v) => setWeights({ price: v })}
              lowHint="Vi får gärna föreslå en dyrare ingrediens om måltiden blir klart bättre."
              highHint="Vi föredrar billigare måltider och byter ut dyra ingredienser."
            />
            <PreferenceSlider
              label="Tid"
              value={state.weights.time}
              onChange={(v) => setWeights({ time: v })}
              lowHint="45 minuter är helt okej om maten är värd det."
              highHint="Vi föreslår genvägar och middagar som verkligen blir klara snabbt."
            />
            <PreferenceSlider
              label="Variation"
              value={state.weights.variation}
              onChange={(v) => setWeights({ variation: v })}
              lowHint="Vi håller oss till sådant ni känner igen."
              highHint="Vi lyfter fram rätter ni inte lagat förut."
            />
            <PreferenceSlider
              label="Enkelt"
              value={state.weights.simple}
              onChange={(v) => setWeights({ simple: v })}
              lowHint="Det får gärna kräva lite pyssel i köket."
              highHint="Få moment, en panna, minimal disk."
            />
          </div>
        )}
      </section>
    </Screen>
  );
}

function TonightSkeleton() {
  return (
    <Screen>
      <div className="animate-pulse">
        <div className="h-3 w-32 rounded bg-muted" />
        <div className="mt-4 h-6 w-20 rounded bg-muted" />
        <div className="mt-8 h-10 w-full rounded bg-muted" />
        <div className="mt-3 h-10 w-3/4 rounded bg-muted" />
        <div className="mt-6 h-3 w-40 rounded bg-muted" />
        <div className="mt-8 h-14 w-full rounded-2xl bg-muted" />
      </div>
    </Screen>
  );
}
