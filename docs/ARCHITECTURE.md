# Matmatch — System Architecture

## 1. Guiding Architectural Principle

**Separate deterministic logic from generative AI, and only let AI touch the parts of the problem that genuinely need creativity or natural language.** Ingredient matching, cost tiering, seasonality, portion math, and allergy filtering are all well-defined enough to be regular application logic — fast, free, deterministic, and testable. AI is reserved for: proposing creative meal directions, adapting/personalizing a suggestion, and handling free-text refinement requests. This is both a cost-control strategy and a safety strategy (allergy filtering must never depend on model behavior).

## 2. Technology Stack

| Layer | Recommendation | Rationale |
|---|---|---|
| Frontend | React + TypeScript, built as a PWA (Vite or Next.js) | Single codebase, installable on mobile, works well with mobile-first responsive design; Next.js if SEO/marketing pages matter early, Vite if the app is purely behind-login |
| Mobile wrapping (later, if needed) | Capacitor | Path to app-store presence and reliable native push notifications without rewriting the frontend, once/if PWA push limitations become a real blocker |
| Backend | Node.js + TypeScript | Shares types/language with frontend, mainstream ecosystem, fast to iterate for a small team |
| Database | PostgreSQL — **Supabase, `eu-north-1`** (decided 2026-08-02) | Relational data (households, members, recipes, orders) is genuinely relational; mature, well-understood. Provider and region are settled — see DECISION_LOG 2026-08-02, including the five binding conditions (Data API disabled, RLS as defense-in-depth only, plain SQL migrations) |
| Vector search (optional, later) | pgvector extension on Postgres | Only if ingredient/recipe similarity matching becomes valuable — avoid introducing a separate vector DB in MVP |
| AI provider | Claude API (Anthropic) | Structured JSON output support, strong instruction-following for constrained generation tasks |
| Auth | **Supabase Auth** (decided 2026-08-02), asymmetric ES256 JWTs verified backend-side with `jose` | No need to build this from scratch; same provider as the database, so identity and row access are one mechanism rather than two. The backend holds no signing secret — it only verifies |
| Payments | Stripe, with Swish/Klarna evaluated for the Swedish market | Stripe for subscription infra; local payment methods likely improve conversion for a 49 SEK/month consumer product |
| Hosting | Vercel/Render/Fly.io (frontend + backend), managed Postgres (Supabase/Neon) | Minimal ops overhead appropriate for MVP-stage team size |
| Analytics | PostHog (or similar) | Needed from day one to test the retention hypothesis, not bolted on later |
| Push notifications | Web Push API (with documented iOS PWA limitations) + email digest fallback | See risk in Product Plan; don't let notification strategy hinge entirely on iOS web push working well |

## 3. System Architecture Overview

```
                          ┌─────────────────────────┐
                          │        Client (PWA)      │
                          │  React + Service Worker   │
                          └────────────┬─────────────┘
                                       │ HTTPS/JSON
                          ┌────────────▼─────────────┐
                          │        API Gateway         │
                          │  (auth, rate limiting,     │
                          │   free-tier usage caps)    │
                          └────────────┬─────────────┘
                                       │
              ┌────────────────────────┼─────────────────────────┐
              │                        │                          │
   ┌──────────▼──────────┐  ┌──────────▼──────────┐   ┌───────────▼───────────┐
   │     Meal Engine       │  │   AI Orchestrator    │   │   Core App Services    │
   │  (deterministic)       │  │                        │   │  (households, users,   │
   │                        │  │  - builds minimal,     │   │   shopping lists,      │
   │  - ingredient matching │  │    structured prompts  │   │   subscriptions)        │
   │  - cost tiering         │  │  - calls Claude API    │   └───────────┬───────────┘
   │  - seasonality logic     │  │  - requests JSON-only  │               │
   │  - portion math           │  │    structured output   │               │
   │  - allergy filtering      │  │  - caches by            │               │
   │    (hard, non-AI)          │  │    template+ingredient  │               │
   └──────────┬──────────┘  │    hash                  │               │
              │              └──────────┬──────────┘               │
              │                          │                          │
              └────────────┬─────────────┴──────────────────────────┘
                           │
                ┌──────────▼──────────┐
                │      PostgreSQL       │
                │  (all persistent data) │
                └───────────────────────┘
```

Key point: the **Meal Engine runs first**. It narrows the problem (valid recipe templates, given household constraints, allergies, and pantry input) using plain application logic and a curated recipe-template library. The **AI Orchestrator is only invoked** when: (a) no template fits well enough, (b) the user wants personalized/creative phrasing, or (c) the user uses the free-text "ask for a tweak" affordance. This keeps the majority of "give me 3 directions" interactions cheap and fast, with AI reserved for where it adds real value.

## 4. AI Architecture & Cost Optimization

### 4.1 Tiered generation strategy
1. **Tier 0 — Template match (no AI call):** the Meal Engine matches household constraints + pantry input against a curated library of recipe templates/skeletons (tagged by protein, cost tier, cuisine, prep time, dietary compatibility). This should satisfy the majority of "give me directions" requests at zero AI cost.
2. **Tier 1 — Templated AI personalization:** when a template exists but needs adapting (e.g., swapping in what the user has, adjusting phrasing to feel personal), call a smaller/cheaper model tier with a minimal, structured prompt and request strict JSON output — no freeform prose to parse.
3. **Tier 2 — Open-ended generation:** only for genuinely novel combinations or free-text refinement requests ("ask for a tweak"), where a larger model may be justified. This tier should be the minority of calls and can be reserved for premium users or capped tightly on free tier.

### 4.2 Cost controls
- **Structured JSON output only** — never let the model produce freeform chat text that needs to be parsed loosely; define a strict schema (direction name, short description, ingredient list, adjustments) so responses are small, predictable, and cheap.
- **Minimal context per call** — send only what's needed: a compact household constraint summary, the chosen ingredients, and the intent — never full conversation history or unrelated data.
- **Cache aggressively** — cache generated results by a hash of (template ID + ingredient set + relevant household constraints) so that similar requests across different users can reuse a result where personalization isn't the point (e.g., non-personalized preview suggestions). Personalized final builds are computed fresh, but the underlying direction generation can often be shared.
- **Model tiering** — use a smaller/cheaper model for routine Tier 1 generation, reserving larger models for Tier 2 and premium personalization.
- **Hard rate limits on free tier** — enforce via a usage counter tied to billing period, checked before any Tier 1/2 call is made (Tier 0 template matching should remain generous even on free tier, since it costs nothing).
- **Never generate specific cost figures via AI.** Cost/savings claims (e.g., "carrots instead of peppers saves ~15 kr") should come from curated, team-maintained cost-tier data, not model output — this avoids a specific, easily-wrong-feeling hallucination risk that would directly damage user trust in the cost-saving value prop.
- **Dev/test environments use mocked AI responses by default** — only staging/production call the real Claude API, so local development and CI don't burn real credits on every run.
- **Log tier + token count per request from the first real call**, not added retroactively — this is what makes the Tier 0:1:2 ratio (an MVP success metric, see MVP_ROADMAP.md) actually measurable.
- **Code review rejects any AI Orchestrator call path that skips the template-match/cache check** — caching and Tier 0 matching only work as a cost control if every code path actually goes through them.

### 4.3 Safety-critical logic stays out of AI entirely
Allergy and hard dietary restriction filtering happens in the **Meal Engine**, before any candidate reaches the AI layer or the user's screen. The AI Orchestrator should never be the last line of defense for a safety constraint — it operates only within a pre-filtered candidate set.

## 5. Database Design (Conceptual Schema)

- **User** — id, email, auth provider info, subscription status
- **Household** — id, owner_user_id. The ownership anchor only: it holds no constraint fields of its own. A household's effective allergy/dietary set is **derived** from its members (`mealConstraints`, `src/engine/constraints.ts`), never stored, so there is one source of truth for safety-critical data
- **HouseholdMember** — id, household_id, type (adult/child), portion_factor, name (optional), allergies[], dietary_flags[] (distinct fields, treated as sensitive — **per-member**; see "Allergy & dietary vocabulary" below for the locked value lists). Constraints were household-level until #115 reversed that — a household does not have allergies, people do, and only the per-member shape can answer *whose* a given restriction is, which is what scoping a meal to the people eating it requires (DECISION_LOG 2026-08-09)
- **Ingredient** — id, name, category, default_cost_tier, peak_months[], available_year_round, seasonality_strength (curated/maintained data, not AI-generated; see "Ingredient schema" below for the locked vocabularies)
- **RecipeTemplate** — id, name, protein_group, cuisine, cost_tier, prep_time_band, dietary_tags[], ingredient_slots[] (role, ingredient_id, substitutable) — see "RecipeTemplate schema & coverage matrix" below for the locked vocabularies and matrix
- **IngredientAllergenMapping** — ingredient_id (FK to Ingredient.id), allergens[], verification_status — the sole source of truth for allergy filtering (§4.3); see "Ingredient-to-allergen mapping" below
- **SubstitutionGroup** — id, name, role, member_ingredient_ids[] — a named set of ingredients interchangeable in a slot of that role; see "Substitution groups" below
- **SessionPantryInput** — id, household_id, session_id, ingredient_ids[] (ephemeral, per-session — explicitly *not* a persistent inventory table)
- **GeneratedMeal** — conceptual, not built as a per-household record: id, household_id, recipe_template_id (nullable if fully AI-generated), final_ingredients[], portions, estimated_cost_tier, created_at, source (template/tier1/tier2). A Tonight suggestion is still recomputed deterministically from household + history on every request, and Tier 1 instruction text is still cached per template + substitution set (`recipe_instructions`) rather than per meal — nothing here carries a household_id. Tier 2's shipped `generated_dishes` (issue #113) is a *different* shape entirely: a household-agnostic cache of the model's raw dish proposal, keyed on `(generator_version, normalized query)`, resolved and safety-checked fresh against the requesting household on every read rather than stored once per generation — see DECISION_LOG 2026-08-09. It is not the GeneratedMeal entity described above.
- **ShoppingList** — conceptual, not built: id, generated_meal_id, items[] (ingredient_id, have/need flag, checked state). The shipped shopping list is client-side and offline-first (`web/src/shoppingListStorage.ts`), keyed on the template id — it deliberately does not depend on a `GeneratedMeal` row existing.
- **CookedMeal** (`cooked_meals`, built — issue #88) — id, household_id, template_id, substitution_key[], cooked_at, cooked_on. This is what feeds repeat-avoidance in Tonight's ranking, and it replaces the conceptual **SavedMeal** for MVP: with no `GeneratedMeal` row to reference, the fact Tonight needs is "this household cooked this template on this day", so that is what is stored. `template_id` is a curated-JSON id, not an FK. `cooked_on` (the Swedish calendar day) carries a unique constraint with household_id + template_id, which is what makes marking a meal cooked idempotent. History is append-only: the application role has SELECT and INSERT only, no UPDATE or DELETE. Row-level security scopes rows to the owning household, inherited through household_id.
- **AnalyticsEvent** (`analytics_events`, built — issue #91) — id, household_id, event_name, payload (jsonb), client_timestamp, server_timestamp. The destination for the typed events `web/src/analytics.ts` emits (`refinement_chip_tap`, `refinement_session_abandoned`, `meal_cooked`) — Phase 1's success metrics (MVP_ROADMAP.md: Weekly Active Deciders, zero-input acceptance rate, repeat-use rate, Tier 0 vs 1/2 ratio) are counted from these. `event_name` and `payload` are validated against a server-side zod mirror of the frontend union (`src/api/routes/analytics.ts`) before any row is written — an unrecognised event name is a 400, not a stored row. Same shape as `cooked_meals`: append-only (SELECT/INSERT only, no UPDATE/DELETE), RLS scoped to the owning household through household_id. No PII beyond household_id — payloads carry only the fields the frontend union already declares (chip ids, weights, template ids, reroll depth), never free text or ingredient names.
- **Subscription** — id, user_id, plan, status, provider_customer_id, provider_subscription_id
- **UsageCounter** — id, user_id, period_start, ai_generation_count (enforces free-tier caps)

Notes:
- Pantry input is intentionally session-scoped, not a standing inventory table, per the UX/product decision to avoid staleness and unnecessary complexity in MVP.
- Allergy data is stored as a distinct, clearly-flagged field (not folded into general preferences) both for UX clarity and because it should be treated as sensitive personal data under GDPR (see Section 7).

### 5.1 Ingredient schema (locked, Phase 0 Day 1)

Locked against a 30-ingredient spot-check spanning proteins, vegetables, dairy, starches, aromatics, condiments, fats, and fruit, plus known edge cases (legumes, mushrooms, nuts). Categorization is by **culinary usage**, not botanical or nutritional classification, since the Meal Engine reasons about how an ingredient functions in a recipe (its role), not what it technically is.

**`category` (enum, one per ingredient):**
- `protein` — meat, poultry, fish/seafood, eggs, and plant-based protein staples (legumes, tofu)
- `vegetable` — fresh/cooked vegetables, including edible fungi used as a vegetable component
- `fruit` — fresh fruit, whether used in sweet or savory contexts
- `dairy` — milk-derived products (milk, cheese, butter, cream, yogurt)
- `starch` — grains, flours, pasta, rice, bread, and potatoes — the carbohydrate base of a meal
- `spice_aromatic` — fresh aromatics (onion, garlic, ginger, fresh herbs) and dried spices/herbs
- `fat_oil` — cooking oils and non-dairy fats (olive oil, rapeseed oil, lard)
- `condiment` — sauces, vinegars, mustards, and other small-quantity flavor additions

**`default_cost_tier` (enum):** `budget` / `mid` / `premium` — curated, team-maintained, per CLAUDE.md (never AI-inferred as a specific price). Approximate Swedish-grocery bands for calibration, reviewed periodically rather than tied to live prices. Displayed to users as a three-dot meter with a Swedish `aria-label` stating the tier, not the raw enum value — see UX_FLOW.md §4 note on the display mapping (amends DECISION_LOG 2026-07-29's original `₤`/`₤₤`/`₤₤₤` glyph mapping).
- `budget` — everyday staples, roughly <40 kr/kg or <15 kr/unit (potatoes, onions, pasta, rice, oats, milk, eggs)
- `mid` — routine but pricier (chicken breast, ground beef, cheese, off-season peppers)
- `premium` — premium or import-heavy (entrecôte, oxfilé, shrimp, out-of-season specialty produce)

**Seasonality fields:**
- `peak_months` (int[], 1-12) — months this ingredient is at its best and cheapest **in Swedish retail**, not months it merely happens to be importable (a Swedish shop stocks imported tomatoes in February; `tomat`'s `peak_months` is `[7,8,9]`, when the Swedish-grown, cheap, good version is around)
- `available_year_round` (boolean) — whether the ingredient has no meaningful Swedish-retail peak at all: staples (rice, dairy, most meat), pantry goods, and imports with no Swedish growing season (citrus, bananas, bell peppers)
- `seasonality_strength` (`strong` / `weak`) — how sharp the quality/price swing is between peak and off-peak for a genuinely seasonal ingredient; `strong` for a hard, narrow window (sparris, jordgubbar, nypotatis); `weak` for a softer swing, often because imports partially fill the gap (tomat, gurka, äpple)

`available_year_round` and `peak_months` are mutually exclusive, enforced by `IngredientSchema` (`src/schema/ingredient.ts`): `available_year_round: true` requires an empty `peak_months`, and `false` requires at least one entry. There is no third state for "year-round but better in peak months" — an ingredient is either a staple with no meaningful Swedish-retail peak, or seasonal with a real window; see DECISION_LOG 2026-08-07 (#50) for why that split was chosen over letting both fields carry information at once.

Chosen over a single `seasonality_tags[]` string array so the Meal Engine can directly compute "in season now" and distinguish a hard seasonal cutoff from a soft price/quality signal, without string-matching a loosely-defined tag vocabulary.

**Known edge cases (documented, not separate categories):**
- Legumes (chickpeas, lentils, beans, tofu) → `protein` — functions as the protein source in vegetarian/vegan templates
- Alliums (onion, garlic, shallot, leek) and ginger → `spice_aromatic`, not `vegetable` — they function as a flavor base, not a vegetable component, even at larger quantities (e.g. purjolök in a soup)
- Mushrooms → `vegetable` — culinary role, not fungal taxonomy
- Nuts & seeds → `condiment` — default assumption is garnish/texture in small quantity; if a future template uses nuts as the primary protein base (e.g. a cashew-based vegan dish), that's a per-recipe-template tagging decision, not a reason to recategorize the ingredient
- Generic entries like "svamp" (mushroom) or "lök" (onion) should be split into specific varieties in the catalog (champinjon vs. kantarell; gul lök vs. rödlök) where cost tier or seasonality genuinely differs — a catalog-content note for issue #6, not a schema gap

### 5.2 Allergy & dietary vocabulary (locked, Phase 0 Day 2-3)

Two distinct, non-interchangeable vocabularies, matching UX_FLOW.md §3/§6's requirement that allergies be visually and structurally distinct from preferences.

**Both are declared per household member, not per household** (#115) — see §5 above. Everything below describes the vocabulary each member's arrays draw from; what the Meal Engine filters against is the union over whichever members a given meal is for, which defaults to all of them.

**`allergies[]` (hard filter, safety-critical, never AI-dependent — see §4.3):**
`gluten`, `dairy_lactose`, `egg`, `tree_nuts`, `peanuts`, `shellfish`, `fish`, `soy`

Scoped to what's actually common in Swedish households, not the full EU 14-allergen regulatory list. Not included in MVP, documented for later if real usage demands it: celery, mustard, sesame, sulphites, lupin, and splitting `shellfish` into crustaceans/molluscs or `dairy_lactose` into milk-protein-allergy/lactose-intolerance (different mechanisms, same hard-exclude behavior for filtering purposes — not worth the added complexity until it's a real user need).

**`dietary_flags[]` (soft preference, informs suggestions, never hard-excludes):**
`vegetarian`, `vegan`, `high_protein_preference`

Scoped tightly to what the current UX flow and Phase 0 template batches (see MVP_ROADMAP.md, "vegetarian & vegan" batch) actually use. `protein_preference` as a separate field is dropped in favor of folding `high_protein_preference` into this same array — UX_FLOW.md §3 already presents it as one more chip alongside the dietary flags, so a single list is simpler than two parallel fields for one screen.

**Not included in MVP dietary flags, documented as future considerations:** pescatarian; gluten-free as a lifestyle choice rather than an allergy (currently, avoiding gluten is only expressible via the `gluten` allergy, which is stricter than intended for a non-allergic preference); religious dietary restrictions (halal, kosher, no-pork) — not covered by the current MVP use case, but plausible for the Swedish market and would need a decision on whether they behave as hard filters (like allergies) or soft preferences before being added; low-carb/keto and other diet systems, out of scope unless a real usage signal supports them.

**Family-friendly cooking is not a dietary flag.** It's derived from household composition (presence of `type: child` members) rather than a separate manually-set preference, to avoid two sources of truth for the same signal.

**`high_protein_preference` per member reads oddly but unions correctly.** It is a soft ranking preference rather than a personal restriction, so "whose" it is matters less than for an allergy. Splitting the vocabulary across two levels to accommodate it would be worse than the mild awkwardness: one member wanting it means the meal is biased that way, which is the right answer, and it becomes diner-scoped for free alongside everything else.

### 5.3 RecipeTemplate schema & coverage matrix (locked, Phase 0 Day 1)

**Fields:**
- `name` — dish name
- `protein_group` (enum) — coverage/generation-batch category, not the same as an ingredient's `category`: `chicken_poultry`, `beef_pork`, `fish_seafood`, `vegetarian_vegan`, `egg_dairy_pantry`. Matches issues #10-14 one-to-one by design.
- `cuisine` (enum) — `swedish_nordic`, `italian_mediterranean`, `asian`, `mexican_texmex`, `middle_eastern`, `american_comfort`. Kept broad and small (6 values) rather than granular (no separate Thai/Vietnamese/Chinese, no separate Greek/Spanish) — matches how a home cook actually thinks about a dish, and keeps the coverage matrix tractable.
- `cost_tier` — reuses the `budget`/`mid`/`premium` enum locked for `Ingredient` in §5.1. No separate template-level cost vocabulary.
- `prep_time_band` (enum) — `<20min`, `20-40min`, `40min+`
- `dietary_tags[]` — reuses the `dietary_flags` vocabulary locked in §5.2 (`vegetarian`, `vegan`, `high_protein_preference`). A template can match zero or more.
- `meal_types[]` (added Phase 1, #68) — which of `breakfast`, `lunch`, `dinner` the dish fits; required, minimum one value, no default. **Authored, not derived** — unlike `cost_tier`/`dietary_tags` (§5.3 derived-field rule, DECISION_LOG 2026-07-31), which meal(s) a dish fits is a judgment call about the dish itself, not something computable from `ingredient_slots[]`. The Tonight suggestion (`selectCandidateTemplates`) hard-filters to templates including `dinner`; see DECISION_LOG for why the field is an array rather than a `dinner`-only boolean.
- `familiarity` (added Phase 1, #72) — `everyday` | `occasional` | `adventurous`, required, no default. **Authored, not derived**, same rationale as `meal_types`. Unlike `meal_types`, this is a **ranking signal only, never a filter** — it feeds a penalty term in `scoreCandidate` (`src/engine/ranking.ts`) so Tonight favors ordinary weeknight food by default, but an `adventurous` template stays fully selectable. Deliberately excluded from the session `RankingWeights` vector (§4, DECISION_LOG 2026-07-31): it is a property of the dish, not a preference a household expresses per session. See DECISION_LOG for the classification pass and how the penalty weight is calibrated against `DEFAULT_WEIGHTS`.
- `ingredient_slots[]` — each slot is `{role, ingredient_id, substitutable}`. `role` is the CLAUDE.md-specified subset of `Ingredient.category` used for slot composition: `protein`, `starch`, `vegetable`, `aromatic` (maps to `spice_aromatic`), `dairy`. `substitutable` gates whether the slot accepts swaps at all; the swap candidates themselves live in the substitution groups of §5.5, not on the template.

**Allergen safety is deliberately *not* a RecipeTemplate field.** No `contains_allergens[]` or similar is stored on the template. Per §4.3, allergy filtering must never be AI-dependent or manually curated — it's computed live (or cached as a derived value) by joining a template's `ingredient_slots[]` against the verified ingredient-to-allergen mapping (§5.4, issues #8/#9). A hand-tagged allergen list on the template would be a second source of truth that goes stale the moment a substitution changes what's actually in the dish — exactly the kind of drift the safety-critical filtering principle exists to prevent.

**Coverage matrix.** Defined as a 2D matrix — `protein_group` × `cuisine` — with a per-cell *target template count*, not a full 4-axis cross-product against `cost_tier` × `prep_time_band`. A full cross-product (5 × 6 × 3 × 3 = 270 cells) would force templates into unrealistic corners (e.g. a premium, 40min+, `egg_dairy_pantry` breakfast-for-dinner dish isn't a real pattern). Instead, `cost_tier` and `prep_time_band` are distributed *within* each cell according to what's realistic for that protein/cuisine combination, per the guidance below. Total target: **170 templates**, within the roadmap's 150-200 range.

| protein_group ↓ / cuisine → | swedish_nordic | italian_mediterranean | asian | mexican_texmex | middle_eastern | american_comfort | row total |
|---|---|---|---|---|---|---|---|
| chicken_poultry | 8 | 8 | 10 | 6 | 5 | 3 | 40 |
| beef_pork | 8 | 7 | 5 | 6 | 3 | 6 | 35 |
| fish_seafood | 8 | 6 | 6 | 2 | 2 | 1 | 25 |
| vegetarian_vegan | 5 | 9 | 10 | 6 | 7 | 3 | 40 |
| egg_dairy_pantry | 8 | 6 | 4 | 3 | 3 | 6 | 30 |
| **column total** | 37 | 36 | 35 | 23 | 20 | 19 | **170** |

Row totals reflect realistic weekly-rotation frequency (chicken and vegetarian/vegan get the most coverage; fish/seafood the least, consistent with typical Swedish household cooking frequency even though nutritionally recommended). Within each row, weight toward cost/prep patterns that actually occur:
- `chicken_poultry` — budget/mid-skewed, mostly 20-40min, some quick stir-fries and a few 40min+ roasts
- `beef_pork` — spans all three cost tiers (mince=budget, fläskfilé=mid, ribeye/entrecôte=premium), mostly 20-40min with some 40min+ braises
- `fish_seafood` — mid/premium-skewed (salmon, shrimp), mostly <20-40min since fish cooks fast
- `vegetarian_vegan` — budget/mid-skewed (legumes, vegetables are cheap), mostly <20-40min
- `egg_dairy_pantry` — budget-skewed, mostly <20min quick meals

### 5.4 Ingredient-to-allergen mapping (locked, Phase 0 Day 3)

The single source of truth for safety-critical allergen filtering (§4.3). A **separate mapping**, not a field on `Ingredient` (§5.1): it has its own per-row verification lifecycle (independent of the ingredient catalog's curated-data status), is reviewable as a bounded ~200-row artifact on its own, and versions independently — an allergen correction is a one-line diff here, not a touch on the catalog record it corrects.

**Shape — one record per ingredient** (not one record per `(ingredient, allergen)` pair):

- `ingredient_id` — foreign key into `Ingredient.id` (§5.1), reusing the same slug-id schema
- `allergens[]` — reuses the `allergies` vocabulary locked in §5.2 (`gluten`, `dairy_lactose`, `egg`, `tree_nuts`, `peanuts`, `shellfish`, `fish`, `soy`). May legitimately be empty — an empty array on a `verified` row is the explicit, positive claim "this ingredient contains none of the tracked allergens," not an unset value.
- `verification_status` (enum, required) — `unverified` / `verified`. `unverified` is what issue #8's AI-drafted rows carry; issue #9 flips a row to `verified` only after a human reviews it. Required (no default, no optional) for the same reason `seasonality_strength` is required in §5.1: an unreviewed row must be structurally impossible to mistake for a reviewed one.

One row per ingredient, not per pair, because it's the only shape that can express "verified, contains nothing" without ambiguity. With per-pair rows, zero rows for an ingredient is indistinguishable between "verified as allergen-free" and "never reviewed" — exactly the silent-allergen-free failure this schema exists to prevent. A full cross-product of per-pair rows (8 allergens × ~200 ingredients) would also multiply the artifact #9 has to 100%-manually-verify roughly eightfold for no product benefit.

**"May contain" / cross-contamination is collapsed into `allergens[]`, not a third state.** Oats with cross-contamination gluten risk, or a sausage with a soy filler, get `gluten` / `soy` in their `allergens[]` exactly like a definite ingredient — there is no `may_contain` distinction. Because §4.3 filtering is a hard binary exclude, not a graded risk score, "may contain" and "definitely contains" require identical downstream behavior for an allergic household, so a third state would add real modeling weight for a distinction nothing currently consumes.

**No `verified_by` / `verified_at` fields.** That's process metadata already captured by git blame and PR review on this file; duplicating it into the row would be a second source of truth for information git already owns.

**Fail-safe enforcement, stated explicitly so a future implementation doesn't default permissive:** the Meal Engine must treat a **missing row** and an **`unverified` row** identically to a row that **contains** the allergen — both exclude the ingredient for a household with that allergy. An ingredient absent from this mapping, or present but not yet verified, is never treated as allergen-free.

Storage: `data/ingredient-allergens.json`, alongside `data/ingredients.json` / `data/recipe-templates.json` / `data/substitutions.json`. Validated via the CLI validator (#15) as `--type ingredient-allergen`, including a coverage check (every catalog ingredient has a mapping row) and an unverified-row count in the summary output — see DECISION_LOG 2026-07-31.

### 5.5 Substitution groups (locked, Phase 0)

What turns 170 templates (§5.3) into several hundred perceived-distinct meals. A **group** is a named, unordered set of ingredients that are interchangeable in a slot of a given role.

**Shape:**
- `id` — slug, reusing the `SlugIdSchema` of §5.1
- `name` — Swedish display text, surfaced in the UI as a swap label ("Lök"). Human-readable prose, not a code identifier.
- `role` — reuses the `IngredientSlotRole` enum locked in §5.3 (`protein`, `starch`, `vegetable`, `aromatic`, `dairy`). No parallel vocabulary.
- `member_ingredient_ids[]` — foreign keys into `Ingredient.id`, **minimum 2**, no duplicates within a group. An ingredient may belong to more than one group.

Lookup is derived, not stored: for a slot, the candidate swaps are the members of any group whose `role` matches the slot's role and whose members include the slot's `ingredient_id`. There is no reverse index field — it would be a denormalization to maintain for a file of this size.

**Groups, not directed pairs.** A group of 4 expresses in one record what directed pairs need 12 rows for, and every one of those rows is a place for the data to contradict itself (an "A → B" row existing while "B → A" doesn't). The group is also the shape the UI actually consumes: the swap sheet shows *the other members*, a set operation rather than a graph traversal. The known limitation is that a group asserts **symmetric** interchangeability and cannot express that one direction is worse (tofu for chicken reads fine; chicken into a tofu-authored dish changes what the dish is). That asymmetry is deliberately left to Meal Engine ranking — which member to prefer for a given household and session is a ranking judgment, not a static property of the data, and encoding it here would compete with the session weight vector (DECISION_LOG 2026-07-31, priority sliders). See DECISION_LOG for the reversal cost.

**Groups must never encode allergen or dietary suitability — in any form.** No allergen field, no dietary flags, no "dairy-free alternatives" group whose *identity* is the restriction it satisfies. Determining which members are safe for a household is Meal Engine logic, computed against the verified ingredient-to-allergen mapping (§5.4) at swap time. A suitability claim baked into a group would be a second source of truth for safety-critical filtering — hand-curated, unversioned against the mapping, and stale the moment an allergen correction lands — which is exactly what §4.3 exists to prevent. It would also route around the fail-safe rule: a group named for being dairy-free would read as safe even for a member whose mapping row is missing or `unverified`.

**`substitutable: false` on a slot suppresses all swaps for that slot**, regardless of whether its ingredient belongs to a group. The template's flag wins — it is the author's statement that this ingredient *is* the dish (the lax in "ugnsbakad lax"), and group membership must not override it. This section is what gives that boolean its meaning; it was a documented placeholder from §5.3 until now.

**Role↔category coherence is deliberately unenforced.** Nothing checks that a member's `Ingredient.category` is consistent with the group's `role` — an ingredient categorized `dairy` in a `protein` group validates clean. Per §5.3, translating between the slot-role and ingredient-category vocabularies is Meal Engine logic and never a string match; adding a mapping to the validator would smuggle that translation into the data layer where it doesn't belong. Members being sensible for their role is an authoring-review responsibility.

**The validator deliberately performs no cost-tier check across a group's members.** Groups are most valuable precisely when members *differ* in tier — the premium→budget swap is the feature, and the "cheaper" adjustment chip depends on it. Enforcing tier homogeneity would delete it. Do not add such a check.

**Open conflict: swap drift against the derived template `cost_tier`.** Per DECISION_LOG 2026-07-31, `RecipeTemplate.cost_tier` is the highest `default_cost_tier` among slot ingredients, validator-enforced. That rule is well-defined **only for the exact ingredient set stored in `ingredient_slots[]`** — the stored tier describes the *canonical* template, not the dish the user sees after a swap. Swap premium lax for mid torsk and the ₤₤₤ badge is stale: a curated number drifted from its source of truth, the failure mode the derived-field rule was written to prevent. **A swapped meal's effective cost tier is undefined until Phase 1.** The two candidate resolutions — recompute the effective tier at swap time, or store the canonical tier plus a derived range — are deliberately left unresolved here; this is the Meal Engine's call to make when it first renders a tier for a swapped meal, not a Phase 0 schema question.

Storage: `data/substitutions.json`. Validated via the CLI validator (#15) as `--type substitution`: schema conformance, duplicate group ids and names, member resolution against the ingredient catalog, no duplicate members within a group, minimum 2 members. As with the other cross-file checks, an invocation passing no ingredient file *warns* rather than passing silently.

## 6. API Surface (High Level)

Shipped (`src/api/routes/`):
- `POST /api/households` — create a household profile
- `GET /api/tonight` — zero-input flagship suggestion (Tier 0 first, falling back to Tier 1 if needed). Optional query parameters carry the session's refinement state, nothing else: `cost`/`time` (the weight vector the adjustment chips mutate), `exclude` (comma-separated template ids already shown), `previous` (the id just rejected). Wrong-typed values are 400s; unknown or stale ids are ignored. There is deliberately no cuisine parameter — see the "Annat kök" note below.
- `POST /api/instructions` — Tier 1 cooking instructions for a suggestion, cached by template + substitution set
- `POST /api/cooked` — marks the dish on the Tonight card as cooked (`{templateId, substitutions[]}`), which is what feeds repeat-avoidance. Idempotent: a repeat tap on the same Swedish calendar day answers 200 with the first tap's timestamp rather than 409, and writes no second row. Recent history itself is *not* an endpoint — `GET /api/tonight` loads it server-side for ranking and returns only `cookedToday` on the suggestion, the one fact the card needs to render its confirmation after a reload.
- `POST /api/analytics/events` — batch ingest for `web/src/analytics.ts`'s typed events (`{events: [{event, clientTimestamp}]}`), issue #91. All-or-nothing: an unrecognised event name or a payload shape that doesn't match the closed vocabulary 400s the whole batch before anything is stored. 204 on success. Read access is a psql query for now — no dashboard or reporting endpoint exists.

Planned, not yet built:
- `GET /households/:id` / `PATCH /households/:id/members`
- `POST /suggestions/directions` — given intent + main ingredient + pantry input, returns 3 direction candidates (Meal Engine filters first, AI Orchestrator fills in only if needed)
- `POST /meals/:id/adjust` — apply a **guided-flow** (§5.5) adjustment chip or a free-text tweak. Tonight-card refinement does *not* use this: it re-requests `GET /api/tonight` with the query parameters above, so a chip tap stays a plain re-rank rather than server-side mutable meal state. Cuisine is never a parameter on either — "Annat kök" resolves it to template-id exclusions client-side, so no new filter dimension enters the API (DECISION_LOG 2026-08-05).
- `POST /meals/:id/confirm` — finalize portions, generate shopping list
- `GET/PATCH /shopping-lists/:id` — retrieve and update checked state
- ~~`POST /meals/:id/save` — mark cooked/save to history~~ — superseded by `POST /api/cooked` above, which keys on the template rather than a persisted meal id (there is no `GeneratedMeal` row to address)
- `GET /usage` — check remaining free-tier generations

## 7. Security & Privacy Notes

- Sweden/EU context means **GDPR applies directly**. Household member data (especially allergies and children's dietary information) is personal data deserving explicit handling: clear consent at collection, minimal retention, and easy deletion/export.
- Allergy data specifically should be treated with the same seriousness as health-adjacent data, even though it's framed casually in the UI — the backend enforcement should not be an afterthought.
- Avoid storing more household/pantry history than needed for the personalization value it provides; session pantry input in particular should have a defined, short retention period rather than accumulating indefinitely.
