Run the close-out checklist for the current change before it's considered done:

1. Self-review: run `/code-review` (and `/security-review` if the change touches auth, payments, or user data).
2. Confirm tests exist and pass for any deterministic logic touched (Meal Engine: matching, cost tiering, portion math, dietary filtering).
3. Confirm relevant docs are updated in this same change, only if architecture or long-term behavior changed (see CLAUDE.md's documentation philosophy — most changes need no doc update at all).
4. Ask whether this change involved a non-obvious decision that belongs in `docs/engineering/DECISION_LOG.md`, and add an entry if so.
5. Confirm the commit message follows Conventional Commits (see `docs/engineering/GIT_AND_GITHUB.md`).
6. Confirm the PR description references the GitHub issue it closes (`Closes #N`) and ends with the "Verifiera i webbläsaren" checklist.

Report each item as done/not-done. Do not ship if tests are failing or a required doc update is missing — fix it, don't flag it and move on.

Then close out: merge on green CI, close the issue, move the card to Done, and report what landed (CLAUDE.md, "Delegation"). Do not park the work waiting for someone to verify it.
