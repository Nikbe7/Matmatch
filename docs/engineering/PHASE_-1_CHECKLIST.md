# Phase -1 — Engineering Foundation: Status & Checklist

This is the entry point for Phase -1. It doesn't restate the reasoning — each linked doc has that — it tracks what's decided, what's built, and what's left before Phase 0 (real data/content work) starts.

## What this phase produced

| Concern | Doc |
|---|---|
| Claude Code setup (models, permissions, memory, hooks, slash commands, context) | [CLAUDE_CODE_GUIDE.md](CLAUDE_CODE_GUIDE.md) |
| Agent strategy | [CLAUDE_CODE_GUIDE.md](CLAUDE_CODE_GUIDE.md#agent-strategy) |
| MCP strategy | [CLAUDE_CODE_GUIDE.md](CLAUDE_CODE_GUIDE.md#mcp-strategy) |
| How Niklas and Claude work together day-to-day | [AI_COLLABORATION.md](AI_COLLABORATION.md) |
| Git branching, commits, versioning, PRs | [GIT_AND_GITHUB.md](GIT_AND_GITHUB.md) |
| GitHub labels, milestones, templates, board, Claude↔GitHub boundary | [GIT_AND_GITHUB.md](GIT_AND_GITHUB.md) |
| What to automate, and when | [AUTOMATION_ROADMAP.md](AUTOMATION_ROADMAP.md) |
| Testing, review, refactoring, tech debt, AI cost discipline | [CODE_QUALITY_AND_COST.md](CODE_QUALITY_AND_COST.md) |
| Documentation structure and ownership | [DOCUMENTATION_MAP.md](DOCUMENTATION_MAP.md) |
| Standing engineering principles | [PRINCIPLES.md](PRINCIPLES.md) |
| Record of decisions made (and left open) | [DECISION_LOG.md](DECISION_LOG.md) |

## Repository changes made in this phase

- `.gitignore` — added (was missing entirely)
- `.claude/settings.json` — baseline permission allowlist/denylist
- `.claude/commands/new-issue.md`, `.claude/commands/ship.md` — process-encoding slash commands
- `.github/ISSUE_TEMPLATE/` — bug report, feature request, tech debt templates
- `.github/PULL_REQUEST_TEMPLATE.md` — includes project non-negotiables as a checklist
- `scripts/setup-github.sh` — idempotent label/milestone setup (not yet run — see below)
- `docs/engineering/` — this folder
- `CLAUDE.md` — Conventions section updated to point here

## Checklist before writing the first line of application code

**Must do (blocking):**
- [x] Install `gh` CLI and run `gh auth login`
- [x] Run `scripts/setup-github.sh` to create labels and milestones
- [x] Manually create the GitHub Projects (v2) board with the six status fields (`Backlog → Ready → In Progress → Review → Testing → Done`)
- [ ] Review and commit everything created in this session (nothing has been committed yet — see below)

**Should do (not blocking Phase 0 start, but do early):**
- [x] Open the first batch of Phase 0 issues — all 21 issues (#1-#21) covering the full Phase 0 day-by-day plan are created, labeled, milestoned (`Phase 0 — Foundations`), and sitting in the project's Backlog column
- [ ] Decide hosting/DB provider (Supabase vs. Neon) and auth provider (Supabase Auth vs. Auth.js) — open items in the decision log; not urgent until Phase 0 needs a real database instance, but don't let it become a last-minute scramble

**Deliberately deferred (do NOT do yet — would violate the Phase -1 scope):**
- Any application code, UI, or database creation
- Lint/test/CI tooling (needs `package.json` to exist first — that's a Phase 0 kickoff task, not a Phase -1 one)
- Hooks beyond what's documented (nothing to hook into yet)

## Sign-off

Phase -1 is "done enough" when the blocking checklist above is complete. It does not need to be perfect — per [PRINCIPLES.md](PRINCIPLES.md) #10, this process only earns its keep if it's cheaper than the friction it prevents. If any part of this foundation turns out to be wrong once Phase 0 starts, fix it then — don't over-invest in getting Phase -1 perfect before any real work has tested it.
