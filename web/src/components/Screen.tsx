import { createContext, useContext, useState, type ReactNode } from "react";
import { BottomNav } from "./BottomNav";

/**
 * How a descendant tells the shell that a modal layer is open (#201).
 *
 * The bottom nav lives here, in the layout route, while the overlays that must
 * suppress it are rendered several levels down inside the routed view — so the flag
 * cannot simply be a prop. Raising the z-index alone was not enough: a nav painted
 * *behind* a sheet is still in the tab order and still reachable by a screen reader,
 * and a dialog claiming `aria-modal="true"` with a live navigation control behind it
 * is a broken interaction, not a cosmetic one.
 *
 * Deliberately one boolean and no registry of open modals. There is exactly one
 * overlay today that needs this, and a counter would be infrastructure for a second
 * one that does not exist yet.
 */
const ModalHostContext = createContext<(open: boolean) => void>(() => {});

/** Call with `true` while a modal layer is mounted; always reset it on unmount. */
export function useModalHost(): (open: boolean) => void {
  return useContext(ModalHostContext);
}

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
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <ModalHostContext value={setModalOpen}>
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
      <BottomNav inert={modalOpen} />
    </div>
    </ModalHostContext>
  );
}
