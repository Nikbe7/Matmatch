# Git & GitHub Workflow

Optimized for one developer working with an AI partner, not a team — every recommendation below trades team-scale ceremony for solo-scale leverage.

## Branching strategy

**Trunk-based, short-lived feature branches.** `main` is always deployable. No `develop` branch — that's coordination overhead for a team merging in parallel, which doesn't apply here.

- Branch naming: `type/short-description` (e.g., `feat/tonight-suggestion-card`, `fix/allergy-filter-null-check`), matching the issue it closes where one exists.
- Branches are short-lived: days, not weeks. If a branch is growing stale, the underlying issue is probably too large — split it.
- Direct commits to `main` are acceptable only for trivial doc-only changes (typo fixes, this document itself). Anything touching application logic goes through a branch + PR, even solo — see "Pull requests" below for why.

## Commit messages

**[Conventional Commits](https://www.conventionalcommits.org/):** `type(scope): summary`, e.g. `feat(meal-engine): add cost-tier filtering`, `fix(allergy): handle missing member field`, `docs: update architecture for pgvector`.

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`. This isn't ceremony for its own sake — it's the input format that makes automated changelog generation and semantic version bumping possible later, without hand-writing either.

## Versioning

**SemVer, starting at `0.x.y` during the MVP phase.** Pre-1.0 signals the API/schema is still expected to change; bump to `1.0.0` at the point Phase 2 validates the core retention hypothesis and the product commits to a stable-ish shape.

- Tag `v0.1.0` at the first real deployed version (end of Phase 1).
- Manual, lightweight tagging is fine solo; introduce automated version bumping (release-please or Changesets) once release cadence stabilizes enough to be worth automating — not before.

## Pull requests (yes, even solo)

Commit straight to `main`? Tempting for a solo dev, but PRs earn their keep here for reasons that have nothing to do with team coordination:
- A concrete point to run `/code-review` against before it's permanent
- `Closes #N` auto-closes the linked issue, which is most of what makes the GitHub board (below) self-maintaining
- A reviewable diff boundary in history, instead of a stream of commits mixed into `main`

**Merge strategy: squash merge.** One commit per feature/issue on `main`, clean history, and it composes well with Conventional Commits + changelog automation (a squash-merged PR title becomes the one commit message that matters).

## Labels

| Label | Meaning |
|---|---|
| `type: feature` / `type: bug` / `type: chore` / `type: docs` / `type: tech-debt` | What kind of work |
| `area: frontend` / `area: backend` / `area: ai` / `area: data` / `area: infra` | Where it lives |
| `priority: p0` / `priority: p1` / `priority: p2` | Urgency, p0 = blocking current phase |
| `phase: 0` / `phase: 1` / `phase: 2` / `phase: 3` | Which [MVP_ROADMAP.md](../MVP_ROADMAP.md) phase this belongs to |

## Milestones

One milestone per roadmap phase (`Phase 0 — Foundations`, `Phase 1 — MVP Core Loop`, etc.), mirroring [MVP_ROADMAP.md](../MVP_ROADMAP.md) directly. An issue without a milestone is either mis-scoped or not yet worth tracking.

## Issue templates

Three templates live in `.github/ISSUE_TEMPLATE/`: **Bug report**, **Feature request**, **Tech debt / chore**. Each forces the reporter (you, or Claude via `/new-issue`) to state: what/why, acceptance criteria, and which phase/area it belongs to — enough for either of you to pick it up cold later without re-deriving context.

## Pull request template

`.github/PULL_REQUEST_TEMPLATE.md` includes the project-specific non-negotiables as a checklist (does this touch allergy logic, does it introduce an AI-invented number, does it add persistent pantry storage) alongside the generic tests/docs checklist — the checklist is the enforcement mechanism for `CLAUDE.md`'s non-negotiables, not just a formality.

## Project board

Single GitHub Projects (v2) board, columns matching the flow you specified:

```
Backlog → Ready → In Progress → Review → Testing → Done
```

- **Backlog**: captured but not yet scoped/prioritized.
- **Ready**: scoped, acceptance criteria clear, could be picked up right now.
- **In Progress**: actively being worked (branch exists).
- **Review**: PR open, self-review (`/code-review`) pending or in progress.
- **Testing**: merged to a preview/staging context or manually verified against acceptance criteria.
- **Done**: deployed/verified, issue closed.

**Working the board (the trigger rules that matter day to day):**
- Starting work on an issue → move it to In Progress.
- Implementation complete → move it to Review.
- Niklas verifies it → move it to Done.
- New work discovered mid-implementation → new Issue, labeled/prioritized/milestoned, added to the project, placed in the right column — not a note in a doc or a comment.

For a solo developer, "Review" and "Testing" don't require a second human — they require the review/testing steps to actually happen and be visible, rather than being silently skipped because there's no one else to hand off to.

## Discussions & Wiki

**Skip both.** Discussions need an audience to be worth the context-switch; a solo project doesn't have one yet (reconsider only if/when there's a real user or contributor community). Wiki content drifts from code because it's unversioned and edited out-of-band — everything a wiki would hold belongs in `docs/` instead, where it's versioned alongside the code it describes.

## Claude ↔ GitHub integration

`gh` CLI is installed and authenticated. All of the below is live.

**Claude should:**
- Read issues/PRs (`gh issue view`, `gh pr view`) to pull context before implementing.
- Draft issues (via `/new-issue`) from bugs or tech debt identified during proactive review.
- Open PRs with a summary and self-review notes.
- Move board items between columns as work progresses.
- Draft changelog/release notes from merged PRs at release time.
- Squash-merge a PR and close its issue — but only once tests are green on the branch, the acceptance criteria are met, and Niklas has said the work is verified. Verification is never inferred from "code written"; without that explicit go-ahead, the PR stays open and the issue sits in Review.

**Should stay manual (human-only), always:**
- Deleting branches or tags.
- Changing repo settings, permissions, or billing.
- Force-pushing anything.

**Not using GitHub MCP** — `gh` CLI via Bash already covers issues, PRs, labels, milestones, and Projects v2; a second integration path for the same system would be redundant. Revisit only if a specific workflow genuinely needs something `gh` can't do.

## Setup script

`scripts/setup-github.sh` creates the labels and milestones described above via `gh`. It's idempotent (safe to re-run if labels/milestones ever need to be recreated) and has already been run once.
