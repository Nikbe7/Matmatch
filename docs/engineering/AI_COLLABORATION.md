# AI Collaboration Rules

How Niklas and Claude work together across the lifecycle of a piece of work. This is process, not tooling (see [CLAUDE_CODE_GUIDE.md](CLAUDE_CODE_GUIDE.md) for tooling).

## Planning
- Non-trivial work starts with a plan (Plan mode for anything architectural or multi-file), not a jump straight to code.
- Claude presents tradeoffs and a recommendation — never a neutral list of options with no opinion. Per [CLAUDE.md](../../CLAUDE.md), "challenge poor decisions, suggest better alternatives" is a standing instruction, not something that needs to be re-requested each time.

## Architecture
- Any change to the Meal Engine / AI Orchestrator boundary, the database schema, or the tech stack is discussed before implementation, regardless of how confident Claude is in the answer.
- Architectural decisions that survive discussion get a [decision log](DECISION_LOG.md) entry — the discussion itself isn't durable, the entry is.

## Coding
- Small, reviewable increments over large speculative changes. A task should produce a diff Niklas can actually read.
- No unrequested abstractions, refactors, or "while I'm here" cleanups bundled into a feature change — call them out separately instead (see [CODE_QUALITY_AND_COST.md](CODE_QUALITY_AND_COST.md) on refactoring).
- Tests for deterministic logic (Meal Engine) are written alongside the code, not deferred to a later pass.

## Debugging
- Root cause over workaround. If a fix requires `--no-verify`, disabling a check, or silencing a warning, that's a signal to stop and understand why, not to proceed.
- After 2+ failed attempts at a bug with Sonnet, escalate to Opus rather than continuing to iterate at the same capability level.

## Reviews
- Every non-trivial change gets a self-review pass before merge — use `/code-review` (and `/security-review` for anything touching auth, payments, or user data) as the "second pair of eyes" a solo developer doesn't otherwise have. Treat its output as real signal, not ceremony.
- Review checklist specific to this project (beyond generic code quality): does this touch allergy-filtering logic? Does it let AI generate a cost figure? Does it add a persistent pantry store? Each is a non-negotiable from `CLAUDE.md` — a review should catch a violation, not just style issues.

## Documentation
- Docs update in the **same** commit/PR as the code change they describe, not as a follow-up cleanup pass. See [DOCUMENTATION_MAP.md](DOCUMENTATION_MAP.md) for what lives where and who owns it.
- Product/architecture docs (`docs/*.md`) are drafted or edited by Claude but approved by Niklas before being treated as settled — they represent product and architecture decisions, not implementation details.

## Refactoring
- Opportunistic only, scoped to files already being touched (boy-scout rule). No dedicated refactor sprints during the MVP phase — see [PRINCIPLES.md](PRINCIPLES.md) #4 and #10.
- A refactor big enough to need its own PR needs its own issue and a stated justification (what it fixes, what it costs), not a rewrite done because it seemed cleaner.

## Testing
- See [CODE_QUALITY_AND_COST.md](CODE_QUALITY_AND_COST.md) for the testing philosophy. In short: heavy on deterministic Meal Engine logic (especially allergy filtering), light on UI/E2E until the UX stabilizes post-validation.

## Releases
- See [GIT_AND_GITHUB.md](GIT_AND_GITHUB.md) for branching, versioning, and tagging mechanics.

## The `/ship` checklist

Before considering a piece of work done (this is what the `/ship` slash command runs through):
1. Self-review passed (`/code-review`, `/security-review` if applicable)
2. Tests written and passing for any deterministic logic touched
3. Relevant doc(s) updated in this same change
4. Decision log entry added, if a non-obvious call was made
5. Commit message follows [Conventional Commits](GIT_AND_GITHUB.md#commit-messages)
6. Linked GitHub issue referenced (`Closes #N`) if one exists
