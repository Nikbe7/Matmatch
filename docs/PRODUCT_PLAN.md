# Matmatch — Product Plan

## 1. Product Vision

**Matmatch is the app people open when they don't know what to cook.**

It is not a recipe database and not a chat wrapper around a language model. It is a decision-assistant: a tool that takes a household's real constraints (who's eating, what's in the kitchen, what things cost right now, how much energy the user has that day) and converges quickly on one finished, shoppable meal.

The product's core bet: **the value isn't in generating recipes — LLMs already do that trivially — the value is in removing the decision-making effort** around a question people face every single day. That means the product must feel fast, personal, and low-effort, not exploratory or chat-heavy.

North star framing: *"Spotify recommends music I like → Matmatch recommends and builds meals that fit my situation."* The analogy is useful but incomplete — Spotify's retention comes from a **passive feed + habit + near-zero friction to consume**. Matmatch needs to borrow that shape (a low-effort home surface you check regularly) rather than only the "personalization" half of the analogy.

### What Matmatch is
- A guided decision tool that ends in a shopping list and a plan, in under a minute for a returning user
- A household-aware system (portions, allergies, preferences) — not a single-user recipe tool
- A cost- and season-aware assistant for the Swedish grocery context
- A tool that gets *faster* to use the more you use it

### What Matmatch is explicitly not
- A recipe search engine or content library
- A conversational chatbot that requires typing to get value
- A grocery price-scraping / coupon app
- A social/community cooking platform (at least not in v1)

## 2. Target User & Core Problem

Primary user: someone (usually a parent, or a couple splitting the mental load of feeding a household) who faces the "what's for dinner" decision on a recurring, often daily or several-times-a-week basis, and experiences it as low-grade but real friction — not because they can't cook, but because deciding is tiring, and the decision has downstream constraints (cost, who's eating, what's already in the fridge, lunch boxes for tomorrow).

This is meaningfully different from:
- Someone looking for a specific recipe (recipe search apps solve this)
- Someone doing weekly batch meal-planning as a project (meal-planning apps like PlateJoy/Mealime solve this, but require upfront effort many users won't give)
- Someone who'd rather just ask ChatGPT (works once, but has no memory of the household, no cost awareness, no shopping list integration, and requires typing every time)

Matmatch's opportunity is the **daily, low-effort, recurring decision** — nobody owns that well today.

## 3. Differentiation & Competitive Reality

Be honest about the competitive set before assuming a clear field:
- **Recipe/meal-planning apps** (Mealime, Whisk, PlateJoy, SideChef): strong content libraries, weak on "decide for me right now" and weak on pantry-driven building.
- **Generic AI chat** (ChatGPT, etc.): infinitely flexible, zero memory of household/pantry/history, no shopping list workflow, no cost awareness, requires typing every session.
- **Swedish grocery apps** (ICA, Coop apps): strong on pricing/loyalty, weak or absent on meal decision-making.

Matmatch's defensible position is the **combination**: household memory + pantry-aware step-by-step building + local cost/season reasoning + a shrinking-effort loop. Any one of these alone is replicable; the combination, tuned for weekly return, is harder to copy quickly.

## 4. MVP Definition

The MVP must prove one thing: **that the interactive, household-aware, pantry-aware meal-building loop is fast and valuable enough that people come back the next week.** Everything else is secondary.

### In scope for MVP
- Household profile creation (members, portion size, basic dietary flags, allergies — hard filters)
- Home screen with a **zero-input "Tonight" suggestion** (the flagship experience)
- Guided quick-select flow as the primary alternative path: intent chip → main ingredient (chosen or AI-suggested) → "what I already have" quick multi-select → 3 direction cards → pick → adjust via chips (cheaper / more protein / more flavor) → portion auto-calculation → shopping list (have vs. buy)
- Optional free-text chat as a refinement layer on top of the guided flow (not the primary path)
- Save/history of completed meals (used to inform future suggestions and avoid repeats)
- Basic freemium gating (limited AI generations/month on free tier)

### Explicitly out of scope for MVP
- Persistent pantry inventory tracking (staleness risk — use ephemeral per-session input instead)
- Multi-day/weekly meal planning calendars
- Barcode or receipt scanning
- Shared/multi-user household editing in real time
- Social features, sharing, community recipes
- Real grocery price scraping or store integration
- Advanced ML-driven personalization (start with simple history-based heuristics)

### MVP success test
A returning user can go from opening the app to a finished shopping list in **under 60 seconds**, without necessarily typing anything, and does this **more than once in a two-week period** without being prompted.

## 5. Monetization Strategy

### Free tier
- Full core loop, but a capped number of AI-personalized generations per month (deterministic/template-based suggestions remain unlimited or generously capped, since they cost nothing)
- Single household profile
- Shopping lists
- **Reconsider ads as the default free-tier lever.** An interruptive ad model sits awkwardly against "trusted daily companion" positioning. Recommend testing **usage caps as the primary constraint** first, with ads as a fallback/secondary lever only if caps alone don't convert well — not baked in as day-one UX.

### Premium (~49 SEK/month, consistent with the original proposal)
- Unlimited AI-personalized generations
- Multiple household profiles (e.g., separate weekday vs. weekend household, or extended family)
- Meal history and "don't repeat this" intelligence
- Multi-day planning (once validated as a real want, not assumed)
- No ads / no caps

### Payment considerations
- Stripe is the default choice for subscription billing
- Given the Swedish market, evaluate **Swish** and **Klarna** as familiar local payment options alongside card payments — this can meaningfully affect conversion for a 49 SEK/month product aimed at everyday consumers

## 6. Risks and Improvements

| Risk | Why it matters | Mitigation |
|---|---|---|
| Retention loop is assumed, not designed | Core business thesis depends on weekly return; currently undefined | Design explicit "Tonight" zero-input surface + notification/digest strategy from day one; measure it in MVP |
| Chat-first UX conflicts with "fast path" goal | Typing is friction on mobile, pre-dinner urgency is real | Make tap/chip-based flow primary; chat is a secondary refinement layer |
| Persistent pantry tracking | Historically fails due to staleness; large engineering cost for low value in MVP | Ephemeral per-session "what I have" input only, in v1 |
| AI-generated specific cost figures (e.g. "saves 15 kr") | Hallucination risk directly damages trust in a cost-savings claim | Use curated cost tiers + seasonal data; AI reasons over tiers, never invents numbers |
| Allergy handling treated as a soft preference | Safety-critical; a wrong suggestion is a real-world harm, not just a bad recommendation | Hard deterministic filtering in the Meal Engine, never dependent on model output |
| iOS PWA push notification limitations | Retention plan likely depends on notifications; iOS web push has real constraints | Build a digest-email fallback; keep a Capacitor/native wrapper path open for reliable push later |
| Ads undermine "trusted companion" feel | Free-tier ads can cheapen a product meant to feel personal and helpful | Test usage caps as the primary free-tier lever before committing to ads |
| Shared household state (partner also using the app) | Real-time shared shopping list/profile is a nontrivial sync problem | Explicitly deferred to v2; MVP is single-owner-per-household |
| No defined success metrics | Can't tell if the core hypothesis (weekly return) is validated | Define and instrument metrics from day one (see MVP_ROADMAP.md) |
| Narrow initial market (Sweden-specific cost/seasonality) | Limits early addressable market, but this is arguably a feature | Treat as an intentional tight beachhead, not a limitation to fix immediately |
| Competitive field isn't empty | Recipe/meal-planning apps and generic AI chat both partially overlap | Differentiate explicitly on household memory + pantry-driven building + shrinking-effort loop, not on AI quality alone |

## 7. Success Metrics (to validate the core hypothesis)

- **Weekly Active Deciders**: users who complete at least one full loop (suggestion → shopping list or save) per week
- **Time-to-decision**: median time from app open to finished shopping list, especially for returning users (should trend down with use)
- **Zero-input acceptance rate**: % of "Tonight" suggestions accepted without modification
- **Repeat-use rate**: % of users who complete the loop 2+ times within 14 days of first use
- **Free-to-premium conversion rate** and the specific trigger point (which cap/feature drives conversion)
- **Shopping list completion rate**: % of generated lists actually marked "used while shopping" (proxy for real-world value delivered, not just engagement)
