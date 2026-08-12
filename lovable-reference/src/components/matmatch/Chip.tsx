import { cn } from "@/lib/utils";

export function Chip({
  children,
  selected,
  onClick,
  size = "md",
}: {
  children: React.ReactNode;
  selected?: boolean;
  onClick?: () => void;
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "rounded-full border transition-all active:scale-[0.97]",
        size === "md" ? "px-4 py-2.5 text-[15px]" : "px-3.5 py-2 text-[13px]",
        selected
          ? "border-primary bg-primary text-primary-foreground shadow-soft"
          : "border-border bg-card text-foreground hover:border-foreground/25",
      )}
    >
      {children}
    </button>
  );
}
