import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Screen } from "@/components/matmatch/Screen";
import { Chip } from "@/components/matmatch/Chip";
import { PreferenceSlider } from "@/components/matmatch/PreferenceSlider";
import { Button } from "@/components/ui/button";
import { useHousehold } from "@/lib/matmatch/store";
import { RECIPE_MAP } from "@/lib/matmatch/data";
import { householdLabel } from "@/lib/matmatch/engine";
import {
  ALLERGEN_LABELS,
  DIET_LABELS,
  type Allergen,
  type DietPreference,
  type Member,
} from "@/lib/matmatch/types";

export const Route = createFileRoute("/profil")({
  head: () => ({
    meta: [
      { title: "Hushållet — Matmatch" },
      {
        name: "description",
        content:
          "Lägg till familjemedlemmar, allergier och matpreferenser så blir Matmatchs förslag mer träffsäkra.",
      },
      { property: "og:title", content: "Hushållet — Matmatch" },
      { property: "og:description", content: "Allergier, preferenser och vad ni lagat tidigare." },
    ],
  }),
  component: Profile,
});

function Profile() {
  const { state, hydrated, setMembers, setWeights, reset } = useHousehold();
  const navigate = useNavigate();
  const [openMember, setOpenMember] = useState<string | null>(null);

  if (!hydrated) return <Screen eyebrow="Hushållet" title="Laddar…">{null}</Screen>;

  const update = (id: string, patch: Partial<Member>) =>
    setMembers(state.members.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  const toggle = <T,>(list: T[], value: T) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  return (
    <Screen eyebrow="Hushållet" title={householdLabel(state.members)}>
      <p className="-mt-3 text-[13px] leading-relaxed text-muted-foreground">
        Allergier är hårda uteslutningar. Preferenser påverkar rankningen.
      </p>

      <section className="mt-7 space-y-3">
        {state.members.map((m) => {
          const open = openMember === m.id;
          return (
            <div key={m.id} className="rounded-2xl border border-border bg-card shadow-soft">
              <button
                type="button"
                className="flex w-full items-center justify-between px-5 py-4 text-left"
                onClick={() => setOpenMember(open ? null : m.id)}
              >
                <span>
                  <span className="text-[16px] font-medium">{m.name}</span>
                  <span className="ml-2 text-[13px] text-muted-foreground">
                    {m.kind === "adult" ? "Vuxen" : "Barn"}
                    {m.allergies.length ? ` · ${m.allergies.length} allergi` : ""}
                  </span>
                </span>
                <span className="text-[13px] text-muted-foreground">
                  {open ? "Stäng" : "Ändra"}
                </span>
              </button>

              {open && (
                <div className="space-y-5 border-t border-border px-5 py-5">
                  <div>
                    <p className="text-eyebrow">Typ</p>
                    <div className="mt-2.5 flex gap-2">
                      {(["adult", "child"] as const).map((k) => (
                        <Chip
                          key={k}
                          size="sm"
                          selected={m.kind === k}
                          onClick={() => update(m.id, { kind: k })}
                        >
                          {k === "adult" ? "Vuxen" : "Barn"}
                        </Chip>
                      ))}
                    </div>
                    <p className="mt-2 text-[12px] text-muted-foreground">
                      Barn räknas som 0,6 portion vid mängdberäkning.
                    </p>
                  </div>

                  <div>
                    <p className="text-eyebrow">Allergier (utesluts helt)</p>
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      {(Object.keys(ALLERGEN_LABELS) as Allergen[]).map((a) => (
                        <Chip
                          key={a}
                          size="sm"
                          selected={m.allergies.includes(a)}
                          onClick={() => update(m.id, { allergies: toggle(m.allergies, a) })}
                        >
                          {ALLERGEN_LABELS[a]}
                        </Chip>
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="text-eyebrow">Preferenser</p>
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      {(Object.keys(DIET_LABELS) as DietPreference[]).map((d) => (
                        <Chip
                          key={d}
                          size="sm"
                          selected={m.diet.includes(d)}
                          onClick={() => update(m.id, { diet: toggle(m.diet, d) })}
                        >
                          {DIET_LABELS[d]}
                        </Chip>
                      ))}
                    </div>
                  </div>

                  {state.members.length > 1 && (
                    <button
                      type="button"
                      className="flex items-center gap-1.5 text-[13px] text-muted-foreground"
                      onClick={() => {
                        setMembers(state.members.filter((x) => x.id !== m.id));
                        setOpenMember(null);
                      }}
                    >
                      <X className="size-3.5" /> Ta bort {m.name}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}

        <button
          type="button"
          onClick={() => {
            const id = `m${Date.now()}`;
            setMembers([
              ...state.members,
              { id, name: `Medlem ${state.members.length + 1}`, kind: "adult", allergies: [], diet: [] },
            ]);
            setOpenMember(id);
          }}
          className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-border py-4 text-[15px] text-muted-foreground"
        >
          <Plus className="size-4" /> Lägg till medlem
        </button>
      </section>

      <section className="mt-10 rounded-2xl border border-border bg-card px-5 py-2 shadow-soft">
        <div className="divide-y divide-border">
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
      </section>

      <section className="mt-10">
        <p className="text-eyebrow">Senast lagat</p>
        {state.history.length === 0 ? (
          <p className="mt-3 text-[14px] text-muted-foreground">
            Inget lagat ännu. Det ni lagar hamnar här och undviks i förslagen ett par veckor.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {state.history.slice(0, 6).map((h, i) => (
              <li key={`${h.recipeId}-${i}`} className="flex items-baseline justify-between gap-3">
                <span className="text-[15px]">{RECIPE_MAP[h.recipeId]?.name ?? "Egen middag"}</span>
                <span className="shrink-0 text-[12px] text-muted-foreground">
                  {relativeDay(h.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-10 flex flex-col gap-2">
        <Button className="h-13 w-full rounded-2xl py-4" onClick={() => navigate({ to: "/" })}>
          Tillbaka till ikväll
        </Button>
        <Button variant="ghost" className="text-muted-foreground" onClick={reset}>
          Återställ hushållet
        </Button>
      </div>
    </Screen>
  );
}

function relativeDay(iso: string) {
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "idag";
  if (days === 1) return "igår";
  if (days < 7) return `för ${days} dagar sedan`;
  if (days < 14) return "förra veckan";
  return `för ${Math.round(days / 7)} veckor sedan`;
}
