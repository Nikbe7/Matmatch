# Matmatch — Project Memory

## What this is
Matmatch is a mobile-first, AI-powered food planning PWA. It helps households decide what to cook using household composition, on-hand ingredients, and Swedish cost/seasonality context. It is NOT a recipe search engine and NOT a chat wrapper — the interaction model is tap-first, with free-text chat as an optional refinement layer only.

## Planning docs (read before making architectural changes)
- `/docs/PRODUCT_PLAN.md` — vision, MVP scope, monetization, risks
- `/docs/UX_FLOW.md` — user journeys, tap-first interaction model, screen-by-screen flow
- `/docs/ARCHITECTURE.md` — tech stack, system design, database schema, AI cost strategy
- `/docs/MVP_ROADMAP.md` — phased plan and current status; includes the Phase 0 data model and day-by-day plan

## Core architectural principle
Deterministic app logic (the "Meal Engine": ingredient matching, cost tiering, seasonality, portion math, allergy filtering) is fully separate from generative AI (the "AI Orchestrator": creative direction generation, personalization, free-text refinement). Allergy/dietary filtering is ALWAYS deterministic — it must never depend on model output. See ARCHITECTURE.md section 4 for the AI tiering strategy (Tier 0 template match / Tier 1 templated personalization / Tier 2 open-ended generation).

## Tech stack
- Frontend: React + TypeScript PWA (Vite), mobile-first, installable
- Backend: Node.js + TypeScript
- Database: PostgreSQL
- AI: Claude API — structured JSON output only, no freeform parsing
- Payments: Stripe (evaluate Swish/Klarna for the Swedish market)
- Analytics: instrumented from day one (see MVP_ROADMAP.md success metrics)

## Current phase: Phase 0 — data foundation
Building: ingredient catalog, recipe template library (structured skeletons — NOT full written recipes), allergy/dietary taxonomy, ingredient substitution relationships. Recipe templates are generated in small batches against a coverage matrix (protein x cuisine x cost tier x prep-time), never one broad prompt. See MVP_ROADMAP.md for the full data model examples and day-by-day plan.

## Non-negotiables
- Ingredient-to-allergen mappings require 100% manual verification — never trust AI-drafted allergen data without review, no sampling.
- Never let AI generate specific cost figures (e.g. "saves 15 kr") — cost tiers are curated, team-maintained data only.
- Pantry/"what I have" input is session-scoped and ephemeral — do not build persistent pantry inventory tracking in MVP.
- Recipe template skeletons store structure (ingredients + roles + tags), not full prose instructions — final phrasing is generated on demand and cached.

## Conventions
Full engineering process (Claude Code setup, AI collaboration rules, git/GitHub workflow, automation roadmap, code quality, documentation structure, engineering principles) lives in `/docs/engineering/` — start at `/docs/engineering/PHASE_-1_CHECKLIST.md`. This section stays short on purpose; update it only when a convention is stable enough to state in one line.

- Branching: trunk-based, short-lived `type/description` branches, squash-merged into `main`. Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, etc.). See `docs/engineering/GIT_AND_GITHUB.md`.
- Lint/test/build commands: not yet defined — no `package.json` exists yet (Phase -1 is process only, no application code). Add here once Phase 0/1 scaffolding introduces them.
