Run the close-out checklist from `docs/engineering/AI_COLLABORATION.md` for the current change before it's considered done:

1. Self-review: run `/code-review` (and `/security-review` if the change touches auth, payments, allergy filtering, or user data).
2. Confirm tests exist and pass for any deterministic logic touched (Meal Engine: matching, cost tiering, portion math, allergy filtering).
3. Confirm relevant docs are updated in this same change (check `docs/engineering/DOCUMENTATION_MAP.md` for what should exist).
4. Ask whether this change involved a non-obvious decision that belongs in `docs/engineering/DECISION_LOG.md`, and add an entry if so.
5. Confirm the commit message follows Conventional Commits (see `docs/engineering/GIT_AND_GITHUB.md`).
6. Confirm the PR description references the GitHub issue it closes (`Closes #N`), if one exists.

Report each item as done/not-done. Do not mark the work complete if tests are failing or a required doc update is missing — flag it instead.
