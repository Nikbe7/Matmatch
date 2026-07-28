# Matmatch — MVP Roadmap

## Guiding Rule

Every phase below exists to test one thing as cheaply as possible: **does the interactive, household-aware, pantry-aware, fast-path meal-building loop actually get people to come back the following week?** Nothing gets built in MVP unless it directly serves that test.

---

## Phase 0 — Foundations (Realistic Solo-Developer Plan, ~1-1.5 weeks)

This phase is often skipped or badly underestimated, and either produces a weak launch (thin content) or an over-invested one (months of hand-written recipes). The realistic middle path: **AI generates volume, the solo developer's time goes into schema design and safety-critical verification, not hand-writing content.**

### What the library actually contains
Not full written recipes — **structured recipe templates (skeletons)**: dish name, ingredients broken into roles (protein/starch/vegetable/aromatic/dairy), substitution slots, and tags (cuisine, cost tier, prep time, dietary compatibility). Full step-by-step phrasing is generated on demand by the AI Orchestrator at request time (Tier 1, cached), not pre-written per template — this is the single biggest lever for cutting manual workload.

Target coverage: **~150-200 templates**, planned as a matrix (protein × cuisine style × cost tier × prep-time band) rather than a flat list, so ingredient-swap logic multiplies this into several hundred perceived distinct meals in practice.

### Day-by-day plan
- **Day 1** — Lock the schema (ingredient, template, substitution, tag vocabularies) before generating any content. Retrofitting a schema onto already-generated data costs more time than designing it first.
- **Day 1-2** — AI-generate the ingredient catalog (~150-250 Swedish home-cooking staples); manually spot-check/correct cost tiers and seasonality against personal grocery knowledge — a fast factual-verification pass, not creative work.
- **Day 2-3** — Manually define the allergy/dietary controlled vocabulary; AI-draft the ingredient-to-allergen mapping, then **manually verify every single row** — the one place where 100% review is non-negotiable, but it's only a few hundred rows, so a few hours, not days.
- **Day 3-5** — AI-generate recipe templates in small batches against the coverage matrix (never one big "generate 200 recipes" prompt — that produces repetitive, generic output), explicitly feeding back already-generated dish names each batch to force diversity.
- **Day 5-6** — Run automated dedup/schema validation; spot-check a stratified ~15-20% sample for tone and quality; hand-polish a small **"hero" subset of ~20-30 templates** that will disproportionately appear in early "Tonight" suggestions — this is where product voice and first-impression quality matter most.
- **Day 6-7** — AI-generate ingredient substitution relationships in batches; spot-check.

### Manual vs. AI-generated
- **Manual (non-negotiable):** allergy categories, dietary flags, ingredient categories, cost-tier definitions, prep-time bands
- **AI-drafted + 100% human-verified:** ingredient-to-allergen mapping (safety-critical)
- **AI-drafted + spot-checked (~20% sample):** cost tiers and seasonality per ingredient
- **AI-generated + sampled review + hand-polished hero subset:** recipe template skeletons, ingredient substitution relationships

### Approximate cost
Raw AI API cost for the ingredient catalog, ~150-200 templates, and substitution relationships (batched, structured-JSON prompts) is roughly tens of dollars — not a meaningful budget line. The real cost of Phase 0 is solo-developer time (~1-1.5 weeks), concentrated in schema design and safety-critical verification, not in writing content by hand.

Exit criterion: enough template/ingredient coverage, verified for safety and spot-checked for cost/seasonality accuracy, that a new household with reasonable preferences gets a good "Tonight" suggestion without needing AI fallback for most common cases — and the hero subset feels genuinely considered rather than generated.

---

## Phase 1 — MVP Core Loop

Build only the single loop described in the Product Plan and UX Flow documents:

1. Household onboarding (members, portions, dietary flags, allergies)
2. Home screen "Tonight" zero-input suggestion (Tier 0 template match, falling back to Tier 1 AI only when needed)
3. Guided quick-select alternative flow (intent chip → ingredient → pantry multi-select → direction cards → adjust chips → portions → shopping list)
4. Optional free-text "ask for a tweak" affordance layered on top (Tier 2, capped)
5. Shopping list with have/buy split, checkable, offline-usable
6. Save/history, feeding back into future "Tonight" suggestions and repeat-avoidance
7. Basic freemium gating (usage counter, cap on AI generations/month)
8. PWA install flow (manifest, service worker) and basic push notification support where feasible, with an email/digest fallback

Explicitly excluded from Phase 1 (do not build yet):
- Persistent pantry inventory / barcode / receipt scanning
- Multi-day/weekly meal planning calendar
- Shared/multi-user household editing
- Social or sharing features
- Real grocery price integrations or scraping
- Advanced ML personalization beyond simple history-based heuristics

Exit criterion: a returning user can go from app open to finished shopping list in under a minute, and the core metrics below can actually be measured on real usage.

---

## Phase 2 — Validate & Iterate

This phase is about proving or disproving the retention hypothesis with real users before investing further.

- Run with a small cohort of real households (ideally recruited directly, not through paid acquisition yet) for several weeks
- Track and review the Success Metrics below weekly
- Specifically test: does the "Tonight" zero-input card get used and accepted, or do people mostly use the guided flow instead? (This tells you where the real value is landing.)
- Test notification/digest effectiveness as a re-engagement driver — this is a likely weak point (see Architecture doc, iOS push limitations) and worth validating early rather than assuming it works
- Identify where AI Tier 1/2 calls are happening most — this tells you where the template library (Phase 0) needs expansion to shift more requests back to free Tier 0 matching

Exit criterion: clear signal on whether users return in week 2 without prompting from the team, and a clear list of the top 3-5 friction points to fix before wider launch.

---

## Phase 3 — Premium & Scale Features (only after Phase 2 validates the core loop)

Only pursue once the core loop is proven to drive repeat use:
- Multiple household profiles (premium)
- Multi-day/weekly meal planning
- Shared household editing (real-time sync)
- Deeper personalization/history-based ML
- Persistent pantry tracking, possibly via barcode/receipt scanning, if user demand is clearly validated (not assumed)
- Native app wrapper (Capacitor) if push notification reliability proves to be a real limiter of retention

---

## Success Metrics (Instrument in Phase 0, Measure Starting Phase 1)

- **Weekly Active Deciders** — users completing at least one full loop per week
- **Time-to-decision** — median time from open to finished shopping list, trending down with repeat use
- **Zero-input acceptance rate** — % of "Tonight" suggestions accepted without modification
- **Repeat-use rate** — % of users completing the loop 2+ times within 14 days
- **Tier 0 vs Tier 1/2 ratio** — what fraction of suggestions are resolved without any AI call (higher is better for cost and speed)
- **Free-to-premium conversion rate** and which cap/moment triggers it
- **Shopping list completion rate** — % of lists actually used/checked off while shopping, as a proxy for real-world value delivered

## Rough Sequencing Note

Treat Phase 0 as non-negotiable and don't compress it to "save time" — a thin template library or inconsistent allergy taxonomy will quietly undermine both the quality of Phase 1's launch and the reliability of the safety-critical filtering described in the Architecture document. Phase 1 should stay scoped tightly enough to ship in weeks, not months; if it's growing beyond the single loop described above, that's a signal to cut scope rather than extend the timeline.
