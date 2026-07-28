# Decision Log

Append-only record of non-trivial, non-obvious decisions — technical choices, scope cuts, schema calls, process changes. Not a changelog of *what* changed (git history has that) — a record of *why*, so nobody (human or Claude) re-litigates a settled question without knowing what was already considered.

**When to add an entry:** any decision that (a) had a real alternative someone could reasonably ask "why not X instead," (b) would be expensive to reverse, or (c) future-you would want the reasoning for, not just the outcome. Skip routine implementation choices — this is not a diary.

**Format:** newest entry at the top. Keep entries short — a paragraph, not a report.

---

## 2026-07-28 — Established Phase -1 engineering foundation

**Decision:** Before any application code, set up documentation structure (`docs/engineering/`), local Claude Code config (`.claude/`), GitHub issue/PR templates (`.github/`), and a git/GitHub workflow — all defined in this session.

**Why:** Solo developer working with Claude Code as a long-term partner; the goal is to spend minimal time on process once implementation starts, which requires the process to exist and be written down first, not improvised per-feature.

**Not decided yet (open, revisit when relevant):**
- Hosting/DB provider: Supabase vs. Neon (see [ARCHITECTURE.md](../ARCHITECTURE.md) §2) — decide when Phase 0 needs a real database instance.
- Auth provider: Supabase Auth vs. Auth.js — same trigger point.
- Whether ads become a free-tier lever at all, vs. usage caps only (see [PRODUCT_PLAN.md](../PRODUCT_PLAN.md) §5) — deferred to real usage data.

---

## 2026-07-28 — `gh` CLI not installed; GitHub-side setup deferred

**Decision:** Label taxonomy, milestones, and the GitHub Projects board are specified in [GIT_AND_GITHUB.md](GIT_AND_GITHUB.md) and scripted in `scripts/setup-github.sh`, but not executed, because the `gh` CLI isn't installed in this environment.

**Why:** Creating labels/milestones/project fields is a remote, shared-system action — better to run it deliberately once, via a reviewable script, than have Claude improvise `gh api` calls piecemeal.

**How to apply:** Install `gh`, run `gh auth login`, then run `scripts/setup-github.sh` once. Delete this entry's "open" status by updating it (or adding a follow-up entry) once done.
