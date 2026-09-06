Propose visual directions for $ARGUMENTS and let Niklas choose one before any code is written.

The rule this command exists for: Niklas decides design by looking, not by reading. Do not
describe a screen in prose and ask if it sounds good — show it.

1. Consult the `product-advisor` subagent for direction. Ask for 2–3 named, genuinely
   different directions for this screen or flow, each with what dominates, what is gone, and
   what it risks — plus which one it would ship. If it comes back with one direction because
   the design is forced (a component fix, a missing state, something the tokens already
   decide), skip to step 6 and just build it.
2. Read `web/src/styles/tokens.css` and the component(s) the change actually touches, so the
   proposals are drawn in the real token set and are buildable as shown — never invented
   colors, type sizes or radii.
3. Read the matching screenshot in `lovable-reference/screenshots/` when one exists. It is a
   benchmark, not a spec: beat it on the states it never had (loading, empty, error, offline,
   dietary), match it on restraint and hierarchy.
4. Build the proposals with the `design` skill: one artboard per direction on a single
   canvas, each a 390px-wide phone frame, real Swedish copy, real content — not lorem, not
   "Rätt 1 / Rätt 2". Label each artboard with its name. Where a direction changes a state
   (empty, loading, error), give that state its own artboard next to the main one.
5. Publish and hand Niklas the link. Then, in at most three sentences: which direction you
   would ship, why, and what it costs. Stop there — do not start implementing.
6. Once he picks: create the GitHub issue (or find the existing one), move it to In Progress
   on the board, and build only the chosen direction. Directions he did not pick are not
   backlog items — they are discarded, unless he says otherwise.

Do not run this for bug fixes, refactors, copy tweaks, or anything already specified in an
issue with a settled design. Three proposals for a two-line change costs more than it saves.
