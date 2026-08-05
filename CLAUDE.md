# Matmatch — Project Memory

## What this is
Matmatch is a mobile-first, AI-powered food planning PWA. It helps households decide what to cook using household composition, on-hand ingredients, and Swedish cost/seasonality context. It is NOT a recipe search engine and NOT a chat wrapper — the interaction model is tap-first, with free-text chat as an optional refinement layer only.

## Planning docs (read before making architectural changes)
- `/docs/PRODUCT_PLAN.md` — vision, MVP scope, monetization, risks
- `/docs/UX_FLOW.md` — user journeys, tap-first interaction model, screen-by-screen flow
- `/docs/ARCHITECTURE.md` — tech stack, system design, database schema, AI cost strategy
- `/docs/MVP_ROADMAP.md` — phased plan and current status; includes the Phase 0 data model and day-by-day plan
- `/docs/engineering/GIT_AND_GITHUB.md` — branching, commits, labels, milestones, PR/board mechanics
- `/docs/engineering/DECISION_LOG.md` — history of non-obvious decisions; check before re-litigating a settled question

## Core architectural principle
Deterministic app logic (the "Meal Engine": ingredient matching, cost tiering, seasonality, portion math, allergy filtering) is fully separate from generative AI (the "AI Orchestrator": creative direction generation, personalization, free-text refinement). Allergy/dietary filtering is ALWAYS deterministic — it must never depend on model output. See ARCHITECTURE.md section 4 for the AI tiering strategy (Tier 0 template match / Tier 1 templated personalization / Tier 2 open-ended generation).

## Tech stack
- Frontend: React + TypeScript PWA (Vite), mobile-first, installable
- Backend: Node.js + TypeScript
- Database: PostgreSQL
- AI: Claude API — structured JSON output only, no freeform parsing
- Payments: Stripe (evaluate Swish/Klarna for the Swedish market)
- Analytics: instrumented from day one (see MVP_ROADMAP.md success metrics)

## Current phase: Phase 1 — MVP core loop
Phase 0 closed 2026-08-02 (DECISION_LOG). Building the single loop MVP_ROADMAP.md's Phase 1 section describes — household onboarding through shopping list, save/history, freemium gating, PWA install — with the deterministic engine and persistence already in place. See MVP_ROADMAP.md for scope and sequence, DECISION_LOG.md for how each piece landed, and the GitHub Project board for current status — not this file.

## Non-negotiables
- Ingredient-to-allergen mappings require 100% manual verification — never trust AI-drafted allergen data without review, no sampling.
- Never let AI generate specific cost figures (e.g. "saves 15 kr") — cost tiers are curated, team-maintained data only.
- Pantry/"what I have" input is session-scoped and ephemeral — do not build persistent pantry inventory tracking in MVP.
- Recipe template skeletons store structure (ingredients + roles + tags), not full prose instructions — final phrasing is generated on demand and cached.

## Don't surprise me
Never make large architectural decisions without discussing them first. If a task requires changing the architecture, introducing a new dependency, changing the database schema, or modifying the roadmap, stop and explain the tradeoffs before implementing. This holds regardless of how confident the right answer seems.

## Engineering principles
1. Deterministic first, AI only where creativity is genuinely required.
2. Safety-critical logic (allergies) is never AI-dependent — no exceptions.
3. Never let AI invent numbers a user will trust (costs, nutrition) — curated data only.
4. Ship the smallest thing that tests the retention hypothesis; cut scope before extending the timeline.
5. Decisions are versioned in the repo (`docs/engineering/DECISION_LOG.md`), not held in memory.
6. Automate the boring and repeatable; keep judgment calls human.
7. Architecture changes are discussed before they're implemented.
8. Prefer boring, proven technology. `main` is always deployable.
9. Process must save more time than it costs — cut any ritual that stops paying for itself.

## Documentation philosophy
This repo prioritizes building Matmatch, not producing documentation. Before creating a new doc, ask: will this realistically be referenced during normal development, does it hold long-term knowledge, and is it the single source of truth for that topic? If not, it belongs in a GitHub Issue, a PR description, a commit message, or the decision log — not a new file.
- Update existing documents instead of creating new ones. Fragmentation is a cost.
- Every doc is the single source of truth for its topic. If two docs could answer the same question, merge them.
- Long-term value only: product vision, architecture, roadmap, UX decisions, engineering conventions, decision log. Never `TODO.md`, `STATUS.md`, `NOTES.md`, or other temporary/status files — the GitHub Project is the task tracker, the decision log is the memory.
- Keep docs concise and dense — reference material, not narrative.

## GitHub Project workflow
The GitHub Project board is the single source of truth for what's being worked on — no separate markdown TODO lists.
- Starting work on an issue → move it to **In Progress**.
- Implementation complete, ready for review → move it to **Review**.
- Niklas verifies it → move it to **Done**.
- New work discovered mid-implementation → create a GitHub Issue immediately (labels, priority, milestone, add to the project, place in the right column) rather than noting it in a comment or a doc.
- Label taxonomy, milestones, and full board mechanics: `docs/engineering/GIT_AND_GITHUB.md`.

## Definition of Done
An issue is considered complete when:
- The implementation satisfies the acceptance criteria.
- The code builds successfully.
- Relevant tests pass.
- No obvious TODOs remain.
- Documentation has been updated if architecture or long-term behavior changed.
- Claude has performed a self-review.
- A Conventional Commit message has been suggested.

Only then should the issue move to Review.

Whenever AskUserQuestion is used, immediately follow it with the same question and options as plain text in the response body — the tool's content can't be copied into the product-advisor chat, and this has repeatedly required digging through session transcripts to answer a question that should have been one paste.

## Task sizing
Never implement multiple unrelated features in the same session. Prefer small, reviewable changes — one issue, one branch, one PR. If a task turns out to bundle unrelated work, split it into separate issues rather than shipping it as one large change.

## Development session workflow
1. Review the GitHub Project board.
2. Recommend the highest-priority actionable issue.
3. Explain the implementation approach before writing code.
4. Implement it.
5. Update relevant docs only if architecture or long-term behavior actually changed.
6. Suggest a commit message (Conventional Commits).
7. Flag when the issue is ready to move to Review — and remind to move it to Done once verified.

Every PR description ends with a "Verifiera i webbläsaren" checklist for Niklas: 3–5 concrete, ordered steps covering what could actually break in this change, expected result for each, and a note on which step is the blocker. The change's author knows its failure modes best — this saves a review round trip.

## Engineering mindset
Optimize for simplicity, maintainability, readability, low AI cost, fast iteration, and production quality, in that rough order for a pre-PMF solo project. Prefer the simplest solution that satisfies current requirements; don't build infrastructure for hypothetical future features.
- Testing: heavy unit coverage on the Meal Engine (matching, cost tiering, portion math, and especially allergy filtering — non-negotiable); light integration tests on API endpoints; minimal UI/E2E investment until the core loop is validated (Phase 2, see MVP_ROADMAP.md).
- Self-review (`/code-review`, plus `/security-review` for anything touching auth, payments, or user data) before moving an issue to Review.

## When to use extended thinking
Use extended thinking only for: architecture, database design, AI orchestration, difficult debugging, and major refactoring. Do not use it for routine CRUD implementation or small UI work — the extra depth is wasted where the shape of the solution isn't in question.

## Conventions
- Branching: trunk-based, short-lived `type/description` branches, squash-merged into `main`. Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, etc.). Full mechanics: `docs/engineering/GIT_AND_GITHUB.md`.
- Typecheck: `npm run typecheck`. Test: `npm test`. Build: `npm run build` (builds the frontend under `web/`; the backend has no build step, it runs directly under `tsx`). No lint step yet.
- Frontend lives under `web/` — Vite + React + TypeScript, its own `package.json`/`npm test`/`npm run typecheck`, wired into the root `typecheck`/`build` scripts via `--prefix web`. See README.md "Frontend" section for local setup and ports.
