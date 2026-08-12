# Lovable Reference

This directory is a pruned, frozen export from Lovable. We are not continuing in
Lovable. It stays in the repo as a design reference only — we take its visual
language, none of its code.

IMPORTANT:

This is reference material only.

The existing Matmatch repository remains the source of truth for:
- product behavior
- architecture
- backend
- API contracts
- database schema
- Meal Engine
- AI architecture
- authentication
- safety-critical logic
- existing product decisions

The Lovable implementation is primarily a reference for:
- visual design
- layout
- spacing
- typography
- component design
- interaction patterns
- visual hierarchy
- perceived product quality
- responsive behavior

Do not copy the Lovable architecture blindly.

Do not replace existing Matmatch functionality simply because the Lovable implementation
uses a different approach.

When integrating the design, preserve existing Matmatch behavior and architecture unless
a deliberate architectural change has been approved separately.

**The export is incomplete** — `Screen.tsx` imports `./BottomNav`, which was never
exported by Lovable. `screenshots/` is the authority for the bottom navigation, and
for anything else the source doesn't show.

**The code no longer builds and is not meant to.** Do not run it, do not install its
dependencies, do not import from it.

## File map

- `src/styles.css` — the design tokens: oklch color palette, Fraunces/DM Sans font
  stack, radius scale, soft/lift shadow values, the `text-eyebrow` and `dot-scale`
  utilities, the rise-in animation.
- `src/routes/index.tsx` — the Tonight screen: hero card, refinement chips, redirect
  interaction.
- `src/routes/bygg.tsx` — the guided quick-select (Build) flow.
- `src/routes/lista.tsx` — the shopping list screen: grouped cards, checkbox rows.
- `src/routes/profil.tsx` — the household profile screen: member cards, allergy/diet
  chip groups, preference sliders (see Do not copy).
- `src/routes/laga.$id.tsx` — the cook/instructions screen (see Do not copy).
- `src/routes/__root.tsx` — app shell boilerplate (fonts, meta, service worker
  registration); low design signal, kept for completeness.
- `src/components/matmatch/Screen.tsx` — the shared page wrapper: eyebrow + title
  header, bottom-nav slot, max-width mobile container.
- `src/components/matmatch/Chip.tsx` — the chip primitive (sm/md sizes, selected
  state) — see Do not copy for the `sm` size.
- `src/components/matmatch/PreferenceSlider.tsx` — kept only as the artifact the
  "Do not copy" entry below refers to.
- `src/lib/utils.ts` — the `cn()` class-merge helper (clsx + tailwind-merge), trivial
  but referenced by the components above.
- `screenshots/` — rendered UI, the authority for anything the source doesn't show
  (see above).

## Take

- The oklch color palette and token structure in `styles.css`.
- The Fraunces (display) + DM Sans (UI) type pairing.
- The `text-eyebrow` idiom (small caps label above a heading).
- Section-level vertical rhythm (the spacing scale between page sections).
- Grouped list cards with dividers (`lista.tsx`, the weights section of `profil.tsx`).
- The two-layer soft shadows (`--shadow-soft`, `--shadow-lift`).
- The 56px (`h-13`/`h-14`) primary button.
- The bottom-nav shell concept (screenshots are the authority for its actual look,
  since `BottomNav.tsx` itself is missing).

## Do not copy

- `PreferenceSlider.tsx` and the preference-slider/accordion pattern it implements.
  Rejected in DECISION_LOG.md (2026-07-31, "Rejected user-facing priority sliders") —
  sliders give no observable consequence per notch, so users can't calibrate them.
- The allergy chip styling in `profil.tsx`. Allergies and preferences are rendered
  with the identical `<Chip size="sm">` there — a safety regression against
  UX_FLOW.md §6, which requires allergies to always be visually distinct by border,
  ground, and glyph, never by color alone.
- `size="sm"` chip dimensions (~34px tall). Below our 44px touch-target requirement.
- `laga.$id.tsx`. It renders full prose cooking instructions; Matmatch deliberately
  stores recipe template structure, not prose, and generates/caches phrasing on
  demand (CLAUDE.md non-negotiables).
