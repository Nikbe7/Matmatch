# Decision Log

Append-only record of non-trivial, non-obvious decisions — technical choices, scope cuts, schema calls, process changes. Not a changelog of *what* changed (git history has that) — a record of *why*, so nobody (human or Claude) re-litigates a settled question without knowing what was already considered.

**When to add an entry:** any decision that (a) had a real alternative someone could reasonably ask "why not X instead," (b) would be expensive to reverse, or (c) future-you would want the reasoning for, not just the outcome. Skip routine implementation choices — this is not a diary.

**Format:** newest entry at the top. Keep entries short — a paragraph, not a report.

---

## 2026-07-29 — Condensed product-advisor agent for decision velocity

**Decision:** Rewrote `.claude/agents/product-advisor.md`'s body (frontmatter unchanged) to optimize for decision velocity over analytical completeness. Response length is now budgeted by question type (quick call / decision / deep dive) instead of a fixed 9-heading template applied to every question. Implementation prompts remain a primary output but are never produced for Delay/Reject verdicts. Claude Code setup guidance (model/effort/context strategy) defaults to Sonnet/medium/continue-chat and is only surfaced when a deviation is warranted, rather than printed on every implementation-suggesting answer.

**Why:** The prior template mandated the same heavy structure regardless of question size, producing ~700-word answers to 20-word questions and extra back-and-forth before reaching the implementation chat. No capability was removed — challenge-me behavior, business/AI/technical lenses, and prompt generation are all preserved, just expressed more tightly.

**How to apply:** If the agent starts under- or over-explaining again, adjust the response-mode thresholds in the agent file directly rather than reverting to the old fixed-template structure.

---

## 2026-07-29 — Validator (#15) moved ahead of data generation (#6, #10-14)

**Decision:** The schema/dedup validator (#15) is built before data generation (#6, #10-14), not after, reversing MVP_ROADMAP.md's original Day 3-5/Day 5-6 ordering.

**Why:** The original plan treated validation as a final inspection. With five independent generation batches, that means cross-batch id collisions and schema drift surface only after 170 templates already exist and are partly hand-verified. Validator-first turns each batch into a feedback loop instead.

**How to apply:** Run the validator against each batch as it lands; accept no batch that hasn't passed. #15 is built and tested against fixtures rather than real data, which is the only cost, and it's marginal.

---

## 2026-07-29 — Swedish-only for MVP; no i18n abstraction

**Decision:** Matmatch is Swedish-language and Swedish-market-specific for MVP. No i18n abstraction is built — no translation keys, no i18n library, no locale column, no language variants in any schema. Swedish is hardcoded. `Ingredient.name` and `RecipeTemplate.name` are Swedish display text; `id` on both is an ASCII slug (see the id-constraint decision above).

**Why:** A second language or market is a Phase 3 decision that needs real market signal, not preparation. An i18n layer pre-PMF is cost without validated benefit. What's "Swedish" about the product is the language, the ingredient availability assumptions from Swedish grocery retail, the cost bands in kronor, and the seasonality months — not the dish repertoire.

**How to apply:** The `cuisine` enum (§5.3) must **not** be narrowed toward husmanskost — Swedish households cook tacos, pasta, and wok, and the coverage matrix is already calibrated for that breadth. If a second language ever becomes relevant, the cost is confined to `name` fields and UI copy; no schema change is needed to make that call later.

---

## 2026-07-29 — Cost-tier enum values changed from glyphs to words; id fields constrained to ASCII slugs

**Decision:** `Ingredient.default_cost_tier` / `RecipeTemplate.cost_tier` data values changed from `₤`/`₤₤`/`₤₤₤` to `budget`/`mid`/`premium`. The three-tier curated model, its Swedish-kr calibration bands, and the "never AI-inferred as a specific price" rule (CLAUDE.md, ARCHITECTURE.md §4.2) are unchanged — only the wire/data representation moved. The glyphs remain in the frontend as a **display-only** mapping (`budget → ₤`, `mid → ₤₤`, `premium → ₤₤₤`), per UX_FLOW.md §4. Separately, `Ingredient.id` and `RecipeTemplate.id` are now constrained to a lowercase ASCII slug (`^[a-z0-9]+(-[a-z0-9]+)*$`); `name` fields are untouched and remain Swedish display text.

**Why:** `₤` is U+20A4 LIRA SIGN, visually near-identical to `£` U+00A3 POUND SIGN — a homoglyph error in ~420 rows of generated data (#6, #10-14) would be effectively invisible in review and would corrupt grep, URL params, CSV export, and DB indexing, for a symbol that means nothing to a Swedish user in the first place. The catalog is authored in Swedish (gul lök, fläskfilé, kantareller); an unconstrained `id` would inherit åäö and risk NFC/NFD normalization mismatches in the same class of places — worse, since two visually identical `ö` can be different byte sequences. Both were caught and fixed before any real data existed, at effectively zero migration cost.

**How to apply:** Frontend cost-tier rendering must map the enum value to a glyph in display code, never reuse `budget`/`mid`/`premium` as if it were the glyph. Ingredient/recipe-template generation (#6, #10-14) must derive `id` as a slug of the Swedish `name` (transliterated, not truncated) rather than an arbitrary counter — see the corresponding issue bodies for the explicit requirement.

---

## 2026-07-29 — Locked RecipeTemplate schema; coverage matrix scoped by realism, not full cross-product

**Decision:** `RecipeTemplate` reuses the `Ingredient` cost-tier enum (§5.1) and the `dietary_flags` vocabulary (§5.2) rather than defining parallel ones; adds its own `protein_group` (5 values, matching issues #10-14 exactly) and `cuisine` (6 broad values) enums. The Phase 0 coverage matrix is `protein_group × cuisine` (30 cells, target 170 templates total) with `cost_tier`/`prep_time_band` distributed *within* each cell per realistic patterns, rather than a full `protein_group × cuisine × cost_tier × prep_time_band` cross-product (270 cells). Allergen safety is explicitly **not** a template field — see ARCHITECTURE.md §5.3.

**Why:** A full 4-axis cross-product forces cells that don't correspond to real cooking patterns (e.g. a premium-tier, 40-minute `egg_dairy_pantry` dish), diluting template quality and generation effort on combinations nobody will use. Weighting the 2D matrix by realistic weekly-rotation frequency (chicken and vegetarian/vegan get the most coverage, fish/seafood the least) makes better use of the ~150-200 template budget. Not storing a `contains_allergens[]` tag on templates avoids a second source of truth for safety-critical data — per CLAUDE.md, allergy filtering must never depend on anything but the verified ingredient-to-allergen mapping (#8/#9), and a hand-tagged template field would silently go stale the moment a substitution changes what's actually in a dish.

**How to apply:** Batch-generation issues (#10-14) should target their row's per-cuisine counts from the matrix table, not generate a uniform count per cuisine. If actual generation reveals a cell genuinely can't support its target count with distinct, non-repetitive dishes (e.g. `fish_seafood × american_comfort` at 1), reduce that cell and redistribute to a stronger cell in the same row rather than forcing filler content — note the change in the batch issue, not by editing this matrix retroactively.

---

## 2026-07-29 — Locked allergy & dietary-flag vocabulary; scoped deliberately narrow for MVP

**Decision:** `allergies[]` (hard filter): `gluten`, `dairy_lactose`, `egg`, `tree_nuts`, `peanuts`, `shellfish`, `fish`, `soy` — not the full EU 14-allergen list. `dietary_flags[]` (soft preference): `vegetarian`, `vegan`, `high_protein_preference`, replacing the separate `protein_preference` field. Full lists and future-consideration notes in [ARCHITECTURE.md §5.2](../ARCHITECTURE.md#52-allergy--dietary-vocabulary-locked-phase-0-day-2-3).

**Why:** Scoped to what MVP actually needs (UX_FLOW.md's onboarding chips, the "vegetarian & vegan" template batch) rather than the maximal correct list, per explicit direction to avoid over-expanding the taxonomy pre-PMF. Two things were deliberately deferred rather than added speculatively: gluten-free-by-choice (currently only expressible as the stricter `gluten` allergy — fine for MVP, revisit if lifestyle users complain) and religious dietary restrictions (halal/kosher/no-pork) — plausible for the Swedish market but not part of the current MVP use case, and would need a decision on hard-filter vs. soft-preference treatment before being added, not a snap call. Family-friendly cooking is derived from household composition (`type: child` present) rather than a new flag, to avoid a second source of truth for the same signal.

**How to apply:** If real usage surfaces demand for any deferred item (pescatarian, gluten-free-as-preference, halal/kosher, sesame/celery/mustard allergies), add it as a new controlled-vocabulary value, not a schema change — `allergies[]`/`dietary_flags[]` are already open arrays. Religious dietary restrictions specifically should get their own scoping discussion (hard vs. soft) before being added, not be folded into the existing lists by default.

---

## 2026-07-29 — Locked Ingredient schema (category taxonomy, cost tiers, seasonality fields)

**Decision:** Ingredient category is an 8-value enum by culinary usage (`protein`, `vegetable`, `fruit`, `dairy`, `starch`, `spice_aromatic`, `fat_oil`, `condiment`) rather than the 6 suggested in issue #1's original text. Seasonality is `peak_months[]` (1-12) + `available_year_round` (boolean) + `seasonality_strength` (`strong`/`weak`), rather than a single loose `seasonality_tags[]` string array or coarser season-name tags. Full definitions and known edge cases (legumes, mushrooms, nuts) are in [ARCHITECTURE.md §5.1](../ARCHITECTURE.md#51-ingredient-schema-locked-phase-0-day-1).

**Why:** A 20-ingredient spot-check against the original 6-category draft failed on cooking oils and fruit — both common in Swedish home cooking, neither fitting `condiment` or `vegetable` without creating semantically wrong groupings that would misfire once recipe templates start matching on category. Category is by culinary usage, not botany/nutrition, since that's what the Meal Engine actually reasons about. For seasonality, month-level granularity plus a year-round/strength split gives the Meal Engine a computable "in season now" signal and separates a hard seasonal cutoff from a soft price/quality one, at only marginal extra curation cost over a coarser scheme.

**How to apply:** Ingredient catalog generation (issue #6) should categorize by function-in-a-dish, not ingredient type — e.g. chickpeas/lentils/tofu are `protein`, mushrooms are `vegetable`, nuts default to `condiment` unless a specific template uses them as the protein base (a template-level tagging call, not a reason to recategorize the ingredient). Split generic catalog entries ("svamp", "lök") into specific varieties wherever cost tier or seasonality genuinely differs between them.

---

## 2026-07-28 — Transitioned from Planning Mode to Development Mode; consolidated engineering docs

**Decision:** Removed `CLAUDE_CODE_GUIDE.md`, `AI_COLLABORATION.md`, `AUTOMATION_ROADMAP.md`, `CODE_QUALITY_AND_COST.md`, `DOCUMENTATION_MAP.md`, `PHASE_-1_CHECKLIST.md`, and `PRINCIPLES.md` from `docs/engineering/`. `docs/engineering/` now holds only `GIT_AND_GITHUB.md` and this decision log. Durable content was merged: engineering principles and the documentation/workflow philosophy into `CLAUDE.md`, AI-cost engineering discipline into `ARCHITECTURE.md` §4.2. The rest (agent/MCP "not now" reasoning, the automation-candidates table, the Phase -1 status checklist) was transitional planning content that had already served its purpose.

**Why:** Phase -1 (engineering foundation) is complete; the priority now is building Matmatch, not maintaining documentation about how to build it. Nine engineering docs was fragmentation with no ongoing payoff — most weren't going to be opened during normal feature work. The GitHub Project board is now the single source of truth for task status; no markdown file should duplicate that.

**How to apply:** Before adding a new doc anywhere in this repo, apply the test in `CLAUDE.md`'s documentation philosophy section. Status/progress/TODO-shaped content goes in GitHub Issues, not markdown.

---

## 2026-07-28 — Phase 0 broken into 21 GitHub issues, all in Backlog

**Decision:** Populated the GitHub Project with 21 issues covering the full Phase 0 plan (schema/vocabulary locks, ingredient catalog generation + review, allergen mapping generation + 100% manual verification, recipe template generation split into 5 batches by protein category, validation tooling, hero-subset polish, substitution generation + review, and a Phase 0 exit review). All milestoned to `Phase 0 — Foundations`, labeled by type/area/priority, and placed in Backlog.

**Why:** MVP_ROADMAP.md's Phase 0 day-by-day plan explicitly warns against generating recipe templates via one large prompt; batching by protein category (chicken/poultry, beef/pork, fish/seafood, vegetarian/vegan, egg/dairy/pantry) gives natural few-hours-sized units that also map to the coverage matrix's primary axis. The safety-critical allergen verification step (#9) and the schema-lock steps (#1-4) are marked `priority: p0` since everything else in Phase 0 depends on them.

**How to apply:** Work the Backlog roughly in dependency order — each issue notes what blocks it. If the ingredient catalog ends up much larger or smaller than the ~150-250 target, the allergen-verification issue (#9) may need splitting into more/fewer sub-issues to stay a few-hours task per sitting; that's expected and noted in the issue body.

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
