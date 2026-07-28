# Automation Roadmap

Automation is a means, not a goal — every item below is included because it removes real recurring toil, not because it's automatable. Effort is rough (S = under an hour, M = a few hours, L = a day+). "Introduce when" is a trigger condition, not a date.

| Automation | Value | Effort | Introduce when |
|---|---|---|---|
| GitHub label/milestone/board setup (`scripts/setup-github.sh`) | Removes manual GitHub UI clicking for a one-time setup; script is reviewable and idempotent | S | Now, once `gh` is installed (see [checklist](PHASE_-1_CHECKLIST.md)) |
| Lint + format on save/pre-commit | Removes style bikeshedding and formatting diffs entirely | S | As soon as `package.json`/ESLint/Prettier exist (start of Phase 0/1 scaffolding) |
| CI: lint + test on every PR | Catches regressions before merge without manual test-running | M | Same trigger — first CI workflow should land with the first test suite |
| Automated changelog + version bump (release-please or Changesets) | Turns Conventional Commits into a changelog/version for free | M | Once release cadence stabilizes (post-Phase 1 first deploy) — premature before there's a real release rhythm to automate |
| Dependency updates (Dependabot/Renovate) | Keeps dependencies current without manual audits; catches security advisories | S | As soon as `package.json` exists — cheap to turn on early, low noise if scoped to weekly batched PRs |
| AI cost/tier telemetry (log Tier 0/1/2 + token count per request) | Makes the Tier 0:1:2 ratio (a defined MVP success metric) actually measurable | M | Phase 1, when the AI Orchestrator first makes a real API call — build this in from the first call, not bolted on later |
| Ingredient/template content generation scripts (batched AI-generation against the coverage matrix) | This *is* Phase 0's actual work — see [MVP_ROADMAP.md](../MVP_ROADMAP.md) | L | Phase 0, days 1-7 per the existing day-by-day plan |
| OpenAPI/API docs generated from code (not hand-written) | Prevents API docs from drifting from the actual implementation | M | Phase 1, once the backend API surface (see [ARCHITECTURE.md](../ARCHITECTURE.md) §6) is implemented |
| Automated schema/dedup validation for generated content | Catches malformed or duplicate AI-generated templates/ingredients before they reach the catalog | M | Phase 0, day 5-6 per the existing plan — already scoped there, just noting it's automatable rather than manual spot-checking alone |
| Preview deployments per PR | Lets you (and eventually Claude, via screenshot tools) verify UI changes before merge | M | Phase 1, once there's a frontend to deploy |
| Release notes drafted from merged PRs | Removes manual changelog writing at release time | S | Bundled with the changelog automation above — same trigger |
| Automated secret scanning (pre-commit + CI) | Prevents an API key or `.env` value from ever reaching a commit | S | Before the first real API key exists in the environment — i.e., now-ish, ahead of most items above |

## Explicitly not automating (yet)

- **Issue triage/prioritization** — a solo developer doesn't need automated backlog grooming; it's fast enough to do by hand and automating it risks hiding bad prioritization behind a process.
- **PR merging** — always human, permanently (see [GIT_AND_GITHUB.md](GIT_AND_GITHUB.md)).
- **Multi-day/weekly content regeneration** — Phase 0 content generation is a deliberate, reviewed batch process, not something that should run unattended on a schedule.
