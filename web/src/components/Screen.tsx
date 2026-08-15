import type { ReactNode } from "react";
import { BottomNav } from "./BottomNav";

/**
 * The shared wrapper for the app's four routed tabs (#137) — centered mobile
 * column, safe-area-aware bottom clearance for the fixed nav below it, and an
 * optional eyebrow/title header. Pre-shell screens (login, onboarding, the
 * loading/offline/error states) render outside this component and use the
 * plain `.page` container instead — see app.css.
 */
export function Screen({
  eyebrow,
  title,
  action,
  children,
}: {
  eyebrow?: string;
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="screen">
      <div className="screen-content">
        {(eyebrow || title) && (
          <header className="screen-header">
            <div>
              {eyebrow && <p className="text-eyebrow">{eyebrow}</p>}
              {title && <h1 className="screen-header__title">{title}</h1>}
            </div>
            {action}
          </header>
        )}
        {children}
      </div>
      <BottomNav />
    </div>
  );
}
