Draft a GitHub issue from the following description: $ARGUMENTS

Follow these rules:
1. Determine the right template shape from `.github/ISSUE_TEMPLATE/` (bug report, feature request, or tech debt/chore) based on the description.
2. Fill in: title, what/why, acceptance criteria, and the relevant `area:` and `phase:` labels (see `docs/engineering/GIT_AND_GITHUB.md` for the label taxonomy).
3. Write it so someone with zero conversation context (including a future Claude session) could pick it up cold.
4. Show the drafted issue body to the user for approval before creating it.
5. Only create the issue via `gh issue create` after explicit approval — do not create it unprompted.

If `gh` is not installed/authenticated, say so and just output the drafted issue body instead.
