## Summary
<!-- What changed and why, in 1-3 sentences -->

Closes #

## Project non-negotiables (see CLAUDE.md)
- [ ] Does not let AI logic make or override allergy/dietary filtering decisions
- [ ] Does not let AI generate specific cost figures (only curated cost-tier data)
- [ ] Does not add persistent pantry inventory storage
- [ ] If this touches the AI Orchestrator: states which tier (0/1/2) it uses and why

## Quality checklist
- [ ] Tests added/updated for any deterministic logic touched (Meal Engine)
- [ ] Docs updated in this same PR, only if architecture or long-term behavior changed (see CLAUDE.md documentation philosophy)
- [ ] Decision log entry added, if a non-obvious call was made
- [ ] Self-reviewed (`/code-review`, plus `/security-review` if auth/payments/user data)
