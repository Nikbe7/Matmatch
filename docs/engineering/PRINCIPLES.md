# Engineering Principles

These are the standing rules for every technical decision on Matmatch. They outrank convenience, speed, and personal taste. When a decision feels hard, it's usually because it conflicts with one of these — resolve the conflict explicitly rather than quietly picking the easy path.

1. **Deterministic first, AI only where creativity is genuinely required.** If a rule can be written in code, write it in code. AI is for the parts of the problem that are actually open-ended (creative direction, phrasing, free-text refinement) — never for things that have a correct answer.
2. **Safety-critical logic is never AI-dependent.** Allergy and hard dietary filtering happens in deterministic code, before AI ever sees a candidate. No exceptions, no "the model is usually right."
3. **Never let AI invent numbers a user will trust.** Costs, savings, nutrition figures — curated, team-maintained data only. A hallucinated number in a trust-sensitive spot is worse than no number.
4. **Ship the smallest thing that tests the hypothesis.** The business bet is that the interactive loop drives weekly return. Every feature earns its place by serving that test; cut scope before extending the timeline.
5. **Decisions are versioned in the repo, not held in memory.** If it mattered enough to debate, it's worth a line in the [decision log](DECISION_LOG.md). Tribal knowledge doesn't survive a break, a bad day, or a new contributor.
6. **Automate the boring and repeatable; keep judgment calls human.** Formatting, changelogs, dependency bumps — automate. Merging to main, closing issues, architecture calls — human, always.
7. **Architecture changes are discussed before they're implemented.** Claude proposes and flags risk; the human approves. This applies regardless of how confident either party is.
8. **Prefer boring, proven technology.** Novelty has to earn its place with a concrete advantage, not curiosity. See [ARCHITECTURE.md](../ARCHITECTURE.md) for the stack this produced.
9. **`main` is always deployable.** No merged-but-broken states. If something isn't ready, it isn't merged.
10. **Process must save more time than it costs.** This is a solo developer working with an AI partner, not a team that needs coordination overhead. Every ritual in these docs is here because it pays for itself — if one stops paying for itself, cut it.
