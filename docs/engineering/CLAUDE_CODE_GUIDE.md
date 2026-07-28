# Claude Code Setup: Models, Agents, MCP

How the Claude Code tool itself is configured for this project. This is about the tool, not about how we collaborate day-to-day (see [AI_COLLABORATION.md](AI_COLLABORATION.md) for that).

## 1. Model selection

**Default: Sonnet (current generation).** It's the right cost/capability tradeoff for the bulk of the work here — CRUD endpoints, React components, test writing, routine debugging, doc updates.

**Escalate to Opus for:**
- Architecture decisions with real switching cost (schema design, API contract shape, the Meal Engine / AI Orchestrator boundary)
- The Phase 0 data model and taxonomy design (ingredient/allergen schema, template structure) — mistakes here get baked into hundreds of generated rows
- Debugging that's resisted two or more Sonnet attempts
- Anything explicitly security- or safety-adjacent (allergy filtering logic, auth, payment integration)

**Drop to Haiku for:** none of this project's current work justifies it yet — Haiku is worth reaching for once there's high-volume, low-stakes, repetitive work (e.g., bulk-classifying generated content, simple lint-fix loops). Revisit once Phase 0 content generation is underway.

**Rule of thumb:** if you'd want a second opinion from a human senior engineer before proceeding, use Opus. If you'd just proceed, Sonnet is fine.

## 2. Thinking / effort level

- **Plan mode + higher effort** for anything touching architecture, the database schema, or more than ~3 files — force an explicit plan and approval step before code changes happen. This is where "challenge the decision, present tradeoffs" (per [CLAUDE.md](../../CLAUDE.md)) actually happens.
- **Standard effort** for routine, well-scoped implementation (a single component, a single endpoint, a template-generation script) where the shape of the solution isn't in question.
- Don't default to maximum effort/thinking for everything — it's slower and the extra depth is wasted on tasks that don't have architectural ambiguity.

## 3. Permissions

Start from `.claude/settings.json` (created alongside this doc) which allowlists safe, read-only, and locally-reversible commands (git status/diff/log, npm test/lint/build once they exist) and leaves everything else — pushes, `gh` mutations, deletions, force operations — requiring explicit confirmation every time.

As trust builds, extend the allowlist deliberately (the `fewer-permission-prompts` skill can scan real usage and propose additions) rather than switching to a blanket "accept all" mode. The categories that should **never** move to auto-accept regardless of how routine they feel:
- `git push`, especially `--force`
- Anything under `gh` that mutates GitHub state (issue/PR creation, merges, label/milestone changes) until the workflow in [GIT_AND_GITHUB.md](GIT_AND_GITHUB.md) is proven out
- Database migrations against anything other than a local/dev instance
- `rm -rf`, `git reset --hard`, `git clean -f`

## 4. Memory

Two layers, used for different things:

- **`CLAUDE.md`** (repo root): short, stable, auto-loaded every session. Non-negotiables, tech stack, current phase, pointers to docs. Keep it lean — it's loaded into every conversation whether relevant or not, so it should never grow into a wiki.
- **Cross-session assistant memory** (outside the repo): durable facts about *how you work* — preferences, standing feedback, project state that changes over time but isn't code. This is where "Niklas wants recommendations, not neutral option lists" or "merge freeze starts on date X" belongs, not in `CLAUDE.md`.

Anything that's true regardless of which machine or session touches this repo belongs in the repo (`CLAUDE.md`, `docs/`). Anything that's about the working relationship or transient project state belongs in assistant memory.

## 5. Hooks

None configured yet — there's no lint/test tooling to hook into (no `package.json` exists). Revisit at the start of Phase 0/1 scaffolding:

| Hook | Purpose | Introduce when |
|---|---|---|
| Pre-commit lint/format | Block commits that fail `eslint`/`prettier` | As soon as those tools are added |
| Pre-push test run | Block pushes with failing unit tests | Once the Meal Engine has a test suite (see [CODE_QUALITY_AND_COST.md](CODE_QUALITY_AND_COST.md)) |
| Secret-scan pre-commit | Block commits containing API keys/`.env` contents | Before the first real API key exists in the environment — i.e., soon |

Don't add hooks pre-emptively for tooling that doesn't exist; a hook that always no-ops is noise.

## 6. Slash commands

Two custom commands are set up now (`.claude/commands/`), because they encode process this document defines and are useful from day one:

- **`/new-issue`** — drafts a well-formed GitHub issue from a short description, following the templates in `.github/ISSUE_TEMPLATE/`.
- **`/ship`** — runs the close-out checklist from [AI_COLLABORATION.md](AI_COLLABORATION.md) (self-review, tests, docs sync) before a piece of work is considered done.

Everything else — code review, security review, simplification passes — already has a built-in skill (`/code-review`, `/security-review`, `simplify`); don't duplicate those with project-specific versions unless they prove insufficient.

## 7. Context management

- Keep `CLAUDE.md` to pointers and non-negotiables, not prose (see above).
- Use `/clear` between genuinely unrelated tasks (e.g., switching from Phase 0 data work to a UX discussion) so context doesn't carry stale assumptions.
- Let auto-compaction handle long sessions; don't manually summarize mid-task.
- Pull a planning doc (`PRODUCT_PLAN.md`, `ARCHITECTURE.md`, etc.) into context only when the task actually touches that concern — `CLAUDE.md` points to them rather than inlining them so they're loaded on demand.

## 8. Project instructions

`CLAUDE.md` is deliberately structured as: what this is → non-negotiables → tech stack → current phase → pointers. That structure should be preserved as the project grows — new non-negotiables get added as short bullets, new phases update the "current phase" line, and anything longer than a bullet point becomes its own doc with a pointer added here.

---

## Agent strategy

**Not justified yet.** Standing, specialized long-running agents (a "backend agent," a "frontend agent") add coordination overhead that only pays off once there's enough parallel, genuinely independent work to justify it — and right now there's no code, so there's nothing to parallelize.

What to use instead, today:
- **Explore** for codebase/doc research once there's a codebase worth exploring.
- **Plan** for architecture/implementation planning on non-trivial features.
- **general-purpose** for self-contained multi-step research tasks.
- Built-in review skills (`/code-review`, `/security-review`) as the quality gate, standing in for the "second reviewer" a solo developer doesn't otherwise have.

**Revisit when:** Phase 1 has independent, parallelizable workstreams (e.g., backend API and frontend UI progressing at the same time) — and even then, prefer ad-hoc worktree-isolated agents per feature branch over standing named roles. A standing multi-agent setup should be justified by a real coordination cost you're actually paying, not adopted speculatively.

---

## MCP strategy

No MCP servers are recommended for Phase -1. `gh` (once installed) via Bash, plus the built-in file tools, cover everything currently needed — adding a server is added surface area (another thing to configure, trust, and keep updated) that isn't buying anything yet.

| Candidate | Purpose | Introduce when | Why not now |
|---|---|---|---|
| GitHub MCP | Structured GitHub API access | Only if `gh` CLI + Bash genuinely can't do something needed (e.g., complex Projects v2 GraphQL automation) | `gh` CLI covers issues/PRs/labels/milestones/projects already; a second integration path for the same system is redundant |
| Postgres MCP | Let Claude query schema/data directly | Phase 0, once a real Postgres instance exists (Supabase/Neon) | No database exists yet |
| Analytics MCP (PostHog or similar) | Query product metrics directly | Phase 2, once there's real usage data to query | No users, no data yet |
| Browser/Puppeteer MCP | Visual verification of UI | Phase 1, if the `run` skill's built-in flow proves insufficient for this project's needs | Untested — don't add until the default flow is shown to be inadequate |

General rule: an MCP server earns its place when it removes a *recurring* manual step that Bash/native tools can't already handle. "It might be useful" is not sufficient justification.
