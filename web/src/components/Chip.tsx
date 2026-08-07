import type { ButtonHTMLAttributes } from "react";

export type ChipVariant = "default" | "danger";

/**
 * `pressed` is optional, not defaulted, because some chips (the momentary
 * "Annat kök" / "Något annat" / "Återställ" actions, UX_FLOW §4) carry no
 * pressed state at all and must not render `aria-pressed="false"`.
 */
export function Chip({
  pressed,
  variant = "default",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { pressed?: boolean; variant?: ChipVariant }) {
  const classes = [
    "chip",
    pressed && "chip-pressed",
    variant === "danger" && "chip-danger",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={classes}
      {...(pressed !== undefined ? { "aria-pressed": pressed } : {})}
      {...props}
    />
  );
}
