import { NavLink } from "react-router-dom";

// Hand-drawn inline SVGs, not an icon library (#137 explicitly rules out
// lucide/etc. for this) — four simple stroke icons matching
// lovable-reference/screenshots/{tonight,mm_bygg,mm_lista,mm_profil}.png,
// the only record of this nav's look since BottomNav.tsx was never exported
// from Lovable. `currentColor` so the active/inactive color switch (driven by
// `aria-current` in app.css) needs no icon-level state.

function IconProps() {
  return {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

function TonightIcon() {
  return (
    <svg {...IconProps()}>
      <path d="M20 14.5A8.5 8.5 0 1 1 11 4a6.7 6.7 0 0 0 9 10.5Z" />
    </svg>
  );
}

function BuildIcon() {
  return (
    <svg {...IconProps()}>
      <path d="M12 3.5 13.4 8.6 18.5 10 13.4 11.4 12 16.5 10.6 11.4 5.5 10 10.6 8.6 12 3.5Z" />
      <path d="M18.5 15v3.5" />
      <path d="M16.75 16.75h3.5" />
    </svg>
  );
}

function ListaIcon() {
  return (
    <svg {...IconProps()}>
      <rect x="4.5" y="3.5" width="15" height="17" rx="2.5" />
      <path d="m8 9 1.5 1.5L12.5 7" />
      <path d="M8 15.5h8" />
    </svg>
  );
}

function ProfilIcon() {
  return (
    <svg {...IconProps()}>
      <circle cx="12" cy="8.3" r="3.3" />
      <path d="M5.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
    </svg>
  );
}

const TABS = [
  { to: "/", label: "Ikväll", Icon: TonightIcon, end: true },
  { to: "/bygg", label: "Bygg", Icon: BuildIcon, end: false },
  { to: "/lista", label: "Lista", Icon: ListaIcon, end: false },
  { to: "/profil", label: "Profil", Icon: ProfilIcon, end: false },
] as const;

/** `inert` while a modal layer is open (#201) — the attribute, not just
 *  `pointer-events`, so the tabs leave the tab order and the accessibility tree
 *  rather than merely stopping short of a click. */
export function BottomNav({ inert = false }: { inert?: boolean }) {
  return (
    <nav className="bottom-nav" aria-label="Huvudnavigation" inert={inert}>
      {TABS.map(({ to, label, Icon, end }) => (
        <NavLink key={to} to={to} end={end} className="bottom-nav__tab">
          <Icon />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
