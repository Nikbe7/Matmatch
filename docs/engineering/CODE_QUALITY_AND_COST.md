# Code Quality & AI Cost Practices

## Testing philosophy

Not all code deserves the same testing investment — match effort to risk and lifespan:

- **Meal Engine (deterministic logic): heavy unit test investment, non-negotiable for allergy filtering.** Ingredient matching, cost tiering, portion math, and especially allergy/dietary filtering are pure functions — cheap to test, safety-critical, and long-lived (they won't be thrown away post-validation the way UI might be). Allergy filtering specifically should have test coverage treated with the same seriousness as the manual-verification rule for allergen data in `CLAUDE.md` — every filter rule needs a test proving it excludes what it should.
- **API endpoints: light integration tests.** Enough to catch broken contracts (wrong status code, malformed response shape), not exhaustive path coverage.
- **UI/E2E: minimal investment until Phase 2 validates the core loop.** The UX is explicitly expected to change based on real usage (see [MVP_ROADMAP.md](../MVP_ROADMAP.md) Phase 2) — heavy E2E investment now risks testing a UI that gets reworked before it matters. Revisit once the core loop is validated and the UI stabilizes.

## Code review philosophy

No second human reviewer exists on a solo project — `/code-review` and `/security-review` are the substitute, not a formality. Treat their findings as real signal: a finding that gets silently dismissed defeats the purpose of running the review at all. See [AI_COLLABORATION.md](AI_COLLABORATION.md) for the project-specific checklist items (allergy logic, AI-invented numbers, persistent pantry storage) reviews should specifically watch for.

## Refactoring strategy

Opportunistic and scoped to files already being touched (boy-scout rule) — no dedicated refactor sprints during the MVP phase. A refactor large enough to need its own PR needs its own issue stating what it fixes and what it costs. See [PRINCIPLES.md](PRINCIPLES.md).

## Documentation standards

See [DOCUMENTATION_MAP.md](DOCUMENTATION_MAP.md) for the full structure. In short: docs update in the same change as the code they describe; API docs are generated from code once there's code to generate them from (see [AUTOMATION_ROADMAP.md](AUTOMATION_ROADMAP.md)), not hand-maintained prose that drifts.

## Technical debt management

Tracked via GitHub issues labeled `type: tech-debt`, triaged at each phase boundary (end of Phase 0, end of Phase 1, etc.) rather than groomed continuously — a solo developer doesn't need a running backlog ceremony, just a deliberate checkpoint before committing to the next phase's scope.

---

## AI cost strategy (engineering practices)

The actual tiering architecture (Tier 0 template match / Tier 1 templated personalization / Tier 2 open-ended generation) is defined in [ARCHITECTURE.md](../ARCHITECTURE.md) §4 — this section is the engineering discipline that keeps that architecture from eroding over time:

- **Every PR touching the AI Orchestrator states which tier it uses and why**, as a PR template checklist item. This is the enforcement mechanism for "AI is reserved for where it adds real value" — it's easy to accidentally reach for Tier 2 out of convenience without this forcing function.
- **Review rejects any AI call path that skips the template-match/cache check.** Caching and Tier 0 matching only work as a cost control if every code path actually goes through them.
- **Dev/test environments use mocked/fixture AI responses by default.** Real Claude API calls happen in staging/production only — local development and CI shouldn't burn real API credits on every test run or every local iteration.
- **Log tier + token count per request from the first real API call**, not added retroactively — this is what makes the Tier 0:1:2 ratio (an explicit MVP success metric) measurable rather than guessed at.
- **Model routing per tier is revisited periodically** (roughly quarterly, or whenever Anthropic ships a relevant pricing/capability change), not hardcoded permanently at initial implementation time.
