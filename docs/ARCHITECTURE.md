# Matmatch — System Architecture

## 1. Guiding Architectural Principle

**Separate deterministic logic from generative AI, and only let AI touch the parts of the problem that genuinely need creativity or natural language.** Ingredient matching, cost tiering, seasonality, portion math, and allergy filtering are all well-defined enough to be regular application logic — fast, free, deterministic, and testable. AI is reserved for: proposing creative meal directions, adapting/personalizing a suggestion, and handling free-text refinement requests. This is both a cost-control strategy and a safety strategy (allergy filtering must never depend on model behavior).

## 2. Technology Stack

| Layer | Recommendation | Rationale |
|---|---|---|
| Frontend | React + TypeScript, built as a PWA (Vite or Next.js) | Single codebase, installable on mobile, works well with mobile-first responsive design; Next.js if SEO/marketing pages matter early, Vite if the app is purely behind-login |
| Mobile wrapping (later, if needed) | Capacitor | Path to app-store presence and reliable native push notifications without rewriting the frontend, once/if PWA push limitations become a real blocker |
| Backend | Node.js + TypeScript | Shares types/language with frontend, mainstream ecosystem, fast to iterate for a small team |
| Database | PostgreSQL | Relational data (households, members, recipes, orders) is genuinely relational; mature, well-understood, good hosting options (Supabase, Neon, RDS) |
| Vector search (optional, later) | pgvector extension on Postgres | Only if ingredient/recipe similarity matching becomes valuable — avoid introducing a separate vector DB in MVP |
| AI provider | Claude API (Anthropic) | Structured JSON output support, strong instruction-following for constrained generation tasks |
| Auth | Standard email/social login (e.g., via Supabase Auth or Auth.js) | No need to build this from scratch |
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
- **Household** — id, owner_user_id, name
- **HouseholdMember** — id, household_id, type (adult/child), portion_size, dietary_flags[], allergies[] (distinct field, treated as sensitive), protein_preference
- **Ingredient** — id, name, category, default_cost_tier, peak_months[], available_year_round, seasonality_strength (curated/maintained data, not AI-generated; see "Ingredient schema" below for the locked vocabularies)
- **RecipeTemplate** — id, name, base_ingredients[], tags (protein type, cuisine, prep_time, cost_tier, dietary_compatibility[])
- **SessionPantryInput** — id, household_id, session_id, ingredient_ids[] (ephemeral, per-session — explicitly *not* a persistent inventory table)
- **GeneratedMeal** — id, household_id, recipe_template_id (nullable if fully AI-generated), final_ingredients[], portions, estimated_cost_tier, created_at, source (template/tier1/tier2)
- **ShoppingList** — id, generated_meal_id, items[] (ingredient_id, have/need flag, checked state)
- **SavedMeal** — id, household_id, generated_meal_id, saved_at (feeds future "Tonight" suggestions and repeat-avoidance)
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

**`default_cost_tier` (enum):** `₤` (budget) / `₤₤` (mid) / `₤₤₤` (premium) — curated, team-maintained, per CLAUDE.md (never AI-inferred as a specific price). Approximate Swedish-grocery bands for calibration, reviewed periodically rather than tied to live prices:
- `₤` — everyday staples, roughly <40 kr/kg or <15 kr/unit (potatoes, onions, pasta, rice, oats, milk, eggs)
- `₤₤` — routine but pricier (chicken breast, ground beef, cheese, off-season peppers)
- `₤₤₤` — premium or import-heavy (salmon, shrimp, prime cuts, out-of-season specialty produce)

**Seasonality fields:**
- `peak_months` (int[], 1-12) — months of peak quality/value; empty if not meaningfully seasonal
- `available_year_round` (boolean) — whether the ingredient is reliably purchasable outside its peak (true for most staples via storage or import; false for a handful of genuinely peak-only items)
- `seasonality_strength` (`strong` / `weak`, only meaningful when `peak_months` is non-empty) — `strong` means quality/price swing noticeably outside peak (tomatoes, cucumbers, bell peppers, mostly imported); `weak` means available and decent year-round but cheaper/better in peak months (potatoes, carrots, apples — store well domestically)

Chosen over a single `seasonality_tags[]` string array so the Meal Engine can directly compute "in season now" and distinguish a hard seasonal cutoff from a soft price/quality signal, without string-matching a loosely-defined tag vocabulary.

**Known edge cases (documented, not separate categories):**
- Legumes (chickpeas, lentils, beans, tofu) → `protein` — functions as the protein source in vegetarian/vegan templates
- Mushrooms → `vegetable` — culinary role, not fungal taxonomy
- Nuts & seeds → `condiment` — default assumption is garnish/texture in small quantity; if a future template uses nuts as the primary protein base (e.g. a cashew-based vegan dish), that's a per-recipe-template tagging decision, not a reason to recategorize the ingredient
- Generic entries like "svamp" (mushroom) or "lök" (onion) should be split into specific varieties in the catalog (champinjon vs. kantarell; gul lök vs. rödlök) where cost tier or seasonality genuinely differs — a catalog-content note for issue #6, not a schema gap

## 6. API Surface (High Level, No Implementation Yet)

- `POST /households` / `GET /households/:id` / `PATCH /households/:id/members`
- `GET /suggestions/tonight` — zero-input flagship suggestion (Tier 0 first, falling back to Tier 1 if needed)
- `POST /suggestions/directions` — given intent + main ingredient + pantry input, returns 3 direction candidates (Meal Engine filters first, AI Orchestrator fills in only if needed)
- `POST /meals/:id/adjust` — apply an adjustment chip (cheaper/more protein/more flavor) or free-text tweak
- `POST /meals/:id/confirm` — finalize portions, generate shopping list
- `GET/PATCH /shopping-lists/:id` — retrieve and update checked state
- `POST /meals/:id/save` — mark cooked/save to history
- `GET /usage` — check remaining free-tier generations

## 7. Security & Privacy Notes

- Sweden/EU context means **GDPR applies directly**. Household member data (especially allergies and children's dietary information) is personal data deserving explicit handling: clear consent at collection, minimal retention, and easy deletion/export.
- Allergy data specifically should be treated with the same seriousness as health-adjacent data, even though it's framed casually in the UI — the backend enforcement should not be an afterthought.
- Avoid storing more household/pantry history than needed for the personalization value it provides; session pantry input in particular should have a defined, short retention period rather than accumulating indefinitely.
