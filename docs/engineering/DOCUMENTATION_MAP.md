# Documentation Map

What exists, who owns it, when it gets updated, and how it stays in sync. The goal is a single source of truth per concern — if two docs could plausibly answer the same question, one of them is wrong or redundant.

## Structure

| Layer | Location | Owner | Updated when |
|---|---|---|---|
| **Project memory** | `CLAUDE.md` (repo root) | Shared, kept lean | Non-negotiables change, tech stack changes, or current phase advances. Pointers only — never inline detail. |
| **Product & architecture** | `docs/*.md` (PRODUCT_PLAN, UX_FLOW, ARCHITECTURE, MVP_ROADMAP) | Niklas approves, Claude drafts | Whenever scope, UX flow, or architecture actually changes — these represent decisions, not implementation notes. |
| **Engineering process** | `docs/engineering/*.md` (this folder) | Shared, living | As process evolves — these are expected to change more often than product docs as real workflow friction surfaces. |
| **Decision history** | `docs/engineering/DECISION_LOG.md` | Shared, append-only | Any time a non-trivial, hard-to-reverse, or non-obvious decision is made. |
| **API documentation** | *(none yet — generated, not hand-written)* | N/A until Phase 1 | Generated from code (OpenAPI) once the backend exists — see [AUTOMATION_ROADMAP.md](AUTOMATION_ROADMAP.md). Hand-written API docs are not planned; they drift. |

## Sync mechanism

The single biggest lever against doc drift for a solo developer: **documentation updates land in the same commit/PR as the code change they describe**, enforced via the PR template checklist — not as a separate "update docs" pass that's easy to defer indefinitely and eventually skip.

## What does *not* get a doc

- Implementation details derivable from reading the code — a doc that just restates the code goes stale the moment the code changes and stops being trusted.
- Anything covered by `git log`/`git blame` (who changed what, when).
- Ephemeral task state — that's what GitHub issues and the project board are for, not docs.

## Adding a new doc

Before creating a new document, check: does this fit in an existing doc's scope? Fragmentation is a cost (more places to keep in sync, more places to look). Only split out a new doc when an existing one would otherwise mix unrelated concerns or grow past the point of being a quick read.
