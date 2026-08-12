import type { ReactNode } from "react";
import { BottomNav } from "./BottomNav";

export function Screen({
  eyebrow,
  title,
  children,
  action,
}: {
  eyebrow?: string;
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto w-full max-w-md px-5 pb-28 pt-8">
        {(eyebrow || title) && (
          <header className="mb-6 flex items-start justify-between gap-4">
            <div>
              {eyebrow && <p className="text-eyebrow">{eyebrow}</p>}
              {title && (
                <h1 className="mt-2 text-3xl leading-tight text-foreground">{title}</h1>
              )}
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
