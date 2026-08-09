# Matmatch — UX Flow & Mobile Strategy

## 1. Design Principles

1. **Tap before type.** Every step in the primary flow should be answerable with a tap. Free-text is an escape hatch for refinement, never a requirement to make progress.
2. **Zero-input is the best input.** The single highest-value screen is the one that requires nothing from the user at all.
3. **Effort shrinks over time.** First-time use can ask more questions (household setup, preferences). Tenth-time use should be near-instant, using history instead of re-asking.
4. **Never let AI override safety.** Allergies and hard dietary restrictions are filtered deterministically before anything reaches the AI layer or the user's screen — never a "soft" AI judgment call.
5. **Fast path first, depth on demand.** The default flow should reach a finished shopping list in well under a minute; deeper customization is available but never mandatory.
6. **Feel like a collaborator, not a form — but a fast one.** The "let's build it together" tone from the original vision is right; it should be expressed through short, confident, low-friction steps rather than open-ended chat turns.

## 2. Primary Interaction Model: Tap-First, Chat-Second

The original vision describes a conversational, turn-by-turn dialogue. That *tone* is right, but a full free-text chat as the **primary** mechanism works against mobile speed and against the "fast path to a finished dinner idea" principle already stated in the source brief. Typing multi-sentence input on a phone, especially at 5pm with hungry kids around, is friction — not delight.

**Recommendation:** structure the core loop as a sequence of tap-able cards and chips (intent chips, ingredient chips, direction cards, adjustment chips), with natural-language chat available underneath as an optional "ask for a tweak" box at any step (e.g., "make it spicier," "swap the cream for something cheaper"). This keeps the collaborative feel without making typing mandatory.

## 3. Onboarding Flow

1. **Welcome** — one screen, states the value prop directly ("Matmatch decides dinner with you, not for you — in under a minute").
2. **Household setup** — add members quickly, each with their own:
   - Adult / Child toggle
   - Portion size (small/regular/large)
   - Optional name (falls back to "Vuxen 1" / "Barn 2" if left blank)
   - Dietary flag chips (vegetarian, high-protein preference, etc.)
   - **Allergies** — a distinct, clearly-marked field per member, not bundled into general "preferences" (safety-critical, per-person data — see Architecture doc §5/§5.2)
   - Lunch boxes needed (yes/no, how many)
3. Skip-friendly: user can add just themselves and move on; household can be edited any time from settings. Don't force a long form before the first "aha" moment.
4. First suggestion is shown immediately after minimal setup — the app should prove its value before asking for more detail.

## 4. Home Screen — The Flagship "Tonight" Experience

This is the single most important screen in the product, and should be positioned as the default landing view, not an afterthought behind a "surprise me" button in a list of options.

- A single card: **"Tonight: [Meal Name]"** — generated automatically, requiring zero taps to see and one tap to accept. Shipped inputs: household composition, the constraints of *the members eating this meal*, season, authored familiarity, and recent cooked history, which penalises a dish for about two weeks after it was cooked rather than filtering it out (#88). Day-of-week is *not* an input and nothing is built for it.
- Below it: a horizontal row of one-tap adjustment chips if the user wants to redirect instead of accepting. Shipped as **Billigare** (+1 `cost`), **Snabbare** (+1 `time`), **Annat kök**, **Något annat** and **Återställ** — each producing a new suggestion immediately, with the two weight chips staying visibly pressed at their level for the rest of the session. Refinement is chip-driven only: no customize sheet, no sliders, no cuisine filter, no user-facing difficulty control (DECISION_LOG 2026-07-31 and 2026-08-05).
- Under the chips: **"Vilka äter?"** — one tap per member, everyone selected (#112). It scopes both the allergy/dietary filter and the portion total to the people eating tonight, so a household with one peanut-allergic child can be shown a peanut dish on an evening that child is away. It is a refinement on a suggestion already on screen, never a step before one: the first request of every session sends no diner set and assumes everyone, and the selection is session-scoped, reset on reload and never written to the profile. The last remaining diner cannot be deselected. A short line names what the code cannot see — leftovers and shared pans still carry the allergen. Hidden entirely for a one-member household.
- "Use what I have" is *not* one of these chips — pantry input is the guided flow's step 3 (§5), not a Tonight-card redirect.
- Accepting the card goes straight into portion confirmation → shopping list. This is the "I don't want to think, just tell me" path, and it should be the fastest possible route through the app.

## 5. Guided Quick-Select Flow (Primary Alternative Path)

For users who want more control than the zero-input suggestion, but still don't want to type:

1. **Pick an intent chip**: Dinner idea / Cheap / Use what I have / High-protein / Meal prep & lunch boxes / Surprise me. **Shipped as five chips, not six** (#107): *Middagsidé*, *Billigt*, *Använd det jag har*, *Proteinrikt*, *Överraska mig* — each mapped onto a lever the Meal Engine already has. *Matlådor* is deliberately absent: it needs a household lunch-box count and a keeps/reheats signal that don't exist (#108). See DECISION_LOG 2026-08-08 for the full mapping and why no new ranking dimension was introduced.
2. **Pick a main ingredient** — either choose one directly (e.g., "chicken") or tap "suggest for me" (AI/engine suggests based on season, price tier, and household history). Shipped as a tap grid of the proteins the most of *the safe dishes for tonight's diners* are built from (the diner set defaults to the whole household, #112) — derived from its own candidate set rather than hand-picked or taken from the whole catalog, so a fish-allergic household is never offered "lax" as a tap target whose only possible outcome is the §9 empty state — plus *Föreslå åt mig* — which reads the main ingredient off the best-ranked candidate, so season, cost tier and history decide it through the existing score rather than a second opinion. **Also shipped (#110):** a type-to-filter input above the grid, narrowing it to a case- and diacritics-insensitive substring match on the household's own safe candidate set — reachable ingredients no longer top out at the ~12 the grid shows. This is the one exception to "no text input" elsewhere in this document: it is catalog filtering over an already-fetched, already-safe option set (deterministic string comparison, no request, no AI), not a search box in the sense §2 rules out — a query can only ever narrow which safe tap targets are visible, never reach outside them. A query matching a catalog protein excluded by the household's own allergies renders a non-tappable explanation naming the allergy (e.g. "Lax är utesluten på grund av fiskallergi") instead of a bare miss; a query matching nothing at all falls back to showing the full grid under a plain "Ingen träff" line, rather than an empty screen. No text input anywhere else in this flow.
3. **Quick pantry input** — a multi-select grid of common ingredients (not a search box), e.g. tapping "rice," "cream," "onion" — this is intentionally ephemeral, per-session input, not a persistent inventory (see Architecture doc, item 4). Shipped as the starch/vegetable/dairy/aromatic staples most common in the household's own safe dishes, and optional: skipping the step is a supported answer. The selection travels on the request and is stored nowhere — not the database, not the household, not localStorage — asserted on both sides by tests named for what they protect.
4. **Direction cards** — 3 options shown as cards, not chat text:
   - "Creamy chicken pasta"
   - "Chicken stew with rice"
   - "Chicken fried rice"
   Each card shows a one-line description and a rough cost tier indicator, not a specific invented price — a display-only rendering of `cost_tier`, never the raw data value itself; see ARCHITECTURE.md §5.1 for the current display mapping.
5. **Build & adjust** — after picking a direction, show what's already covered (✓ rice, ✓ cream, ✓ onion) and what's suggested to add (carrots, garlic, chicken), with adjustment chips: **Cheaper / More protein / More flavor**. Tapping a chip regenerates the suggestion set live. **Shipped in part:** the covered/needed split is there — each card names the pantry ingredients it already uses, and the shopping list opens with those in "Har hemma" — but the adjustment chips on the direction set are a follow-up slice, not built. When directions run out, §9's loosen actions are the recovery: drop the pantry, or drop the main ingredient, without leaving the cards.
6. **Portion confirmation** — household composition is pre-filled from the profile (e.g., "2 adults + 2 children + 4 lunch boxes"); user can adjust with steppers, not typing. Shipped as a single portion total seeded from the `portion_factor` sum of *the diners eating this meal* (§4's picker, also shown on this flow's cards step), adjusted with − / + steppers and floored at 1; the adjustment is session-scoped and never written back to the household profile. Portions and the allergy filter come from one resolution of the diner set (#112), so deselecting someone both stops applying their allergy and stops buying their portion — the two cannot disagree about who is eating. Lunch boxes are not part of it (#108).
7. **Shopping list** — auto-split into "Already have" and "Need to buy," with checkboxes designed for in-store use (large tap targets, works offline).
8. **Save / Mark as cooked** — closes the loop and feeds history back into future "Tonight" suggestions. **Shipped, but on the Tonight card (§4), not here:** "Lagad ikväll" is a one-tap action on the suggestion card with a persistent visible confirmation, recording the dish so it is penalised in ranking for about two weeks (DECISION_LOG 2026-08-05, repeat-avoidance). A shopping-list-completion variant — marking cooked at the *end* of the flow, after shopping — is not built: the card is where a household already is when they decide, and one entry point is enough to feed history. There is deliberately no history screen, no editing and no deleting of past entries.

Free-text chat is available as a persistent small affordance at the bottom of steps 4–6 ("Ask for a tweak…") for anything the tap model doesn't cover — this is where the model's flexibility earns its cost, on the minority of sessions that need it. **Not built.** It is Tier 2, and it is sequenced after this flow and after Tier 1 — see the DECISION_LOG entry on free-text lookup for the allergy gate it has to pass first.

## 6. Household Profile Management

- Accessible from settings, not gated behind onboarding forever
- Add/edit/remove members at any time
- Allergies and dietary flags belong to the member, not the household (ARCHITECTURE.md §5) — each member's card carries its own, and they stay visually distinct from each other in the UI: a red/warning-style treatment for allergies reinforces that these are hard constraints, not soft ones
- v1 assumes a single owner/editor per household profile (multi-user shared editing is a v2 concern — see Product Plan risks)

## 7. Shopping List UX

- Grouped by store section where feasible (produce, dairy, meat, pantry) to be genuinely useful while shopping, not just a copy of the recipe ingredient list
- Checkable items, persists across app close/reopen, usable offline
- Clear "Buy" vs "Already have" split, matching the original brief's example directly

## 8. Re-engagement & Notifications

- A daily/near-daily nudge is central to the retention hypothesis, but push notification reliability varies significantly by platform for a PWA (iOS Safari web push has real limitations). Plan two channels:
  - **Push notification** where supported (Android reliably, iOS with caveats)
  - **Email/SMS digest fallback** ("Tonight's suggestion: Chicken fried rice — see shopping list") for users where push isn't reliable
- Notification content should always be the *answer*, not a prompt to open the app and start typing — consistent with the zero-effort principle.

## 9. Edge Cases & Empty States

- **New user, no history yet**: "Tonight" card falls back to season + popularity + declared preferences only; be transparent that suggestions improve with use.
- **No good direction fits pantry input**: offer to loosen constraints (e.g., "add 1-2 more ingredients to unlock better options") rather than a dead end. Shipped as two one-tap actions on the cards step — drop the pantry, or drop the main ingredient — plus a distinct state for a household whose *own* constraints leave nothing, which needs its profile changed rather than its selections. In practice this is now a safety net rather than a routine path: since the step-2 grid is built from the diners' own candidate set (§5), a fresh session cannot tap its way into it at all. Preventing the dead end is the stronger reading of this rule than recovering from it; the recovery stays for a stale grid (a profile edited in another tab). Changing who is eating is the other way out, and the picker stays visible through both empty states for exactly that reason.
- **Allergy conflict with a chosen direction**: the direction should never be shown in the first place — filtering happens before suggestions are generated, not as a warning after the fact.
- **Free tier generation cap reached**: clearly explain the cap and premium upgrade path, but continue to allow deterministic/template-based suggestions (i.e., never leave a free user with literally nothing to do that day).
