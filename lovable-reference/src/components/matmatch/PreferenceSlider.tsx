import { Slider } from "@/components/ui/slider";

export function PreferenceSlider({
  label,
  value,
  onChange,
  lowHint,
  highHint,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  lowHint: string;
  highHint: string;
}) {
  const high = value >= 50;
  return (
    <div className="py-4">
      <div className="flex items-baseline justify-between">
        <span className="text-[15px] font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">
          {value < 30 ? "Spelar liten roll" : value < 65 ? "Spelar viss roll" : "Spelar stor roll"}
        </span>
      </div>
      <Slider
        aria-label={label}
        className="mt-3"
        value={[value]}
        min={0}
        max={100}
        step={5}
        onValueChange={(v) => onChange(v[0] ?? value)}
      />
      <p className="mt-2.5 text-[13px] leading-relaxed text-muted-foreground">
        {high ? highHint : lowHint}
      </p>
    </div>
  );
}
