# Sniff — Product Improvement Analysis

*A first-principles analysis of where Sniff can improve, grounded in who the user is, what they actually need, and where the current product drops them.*

---

## Understanding the User

**Who they are:** Indian cat parents in metro cities (Bangalore, Delhi, Mumbai, Pune, Hyderabad). Aged 25-40, urban, digitally native, often first-generation pet parents. They grew up in homes where pets ate table scraps — now they're trying to do better, but don't know what "better" looks like.

**What they feel:** Anxiety. Not crisis-level, but a low hum of doubt. "Am I feeding the right thing?" They've Googled at 2 AM. They've scrolled Instagram reels. They've read Amazon reviews that say "my cat loves it!" without a single mention of what's actually in it. They don't trust the vet's recommendation because it felt like a brand endorsement. They don't trust Instagram because every creator has a different answer. They don't trust themselves because they never studied animal nutrition.

**The job-to-be-done:** The user isn't hiring Sniff to "analyze cat food." They're hiring it to **feel confident that they're not harming their cat.** The analysis is a means. Confidence is the end.

**Behavioral context:**
- Cat parents in India change food 1-3 times in the first year of ownership, then settle into a pattern
- Triggers for food change: vet visit, social media scare, cat refusing food, health issue, budget shift
- Decision process: anxiety → research (2 AM Google) → social validation (community) → trial → judgment based on cat's behavior
- Price sensitivity is real: ₹33/day vs ₹95/day is the difference between "manageable" and "luxury" for most households

---

## What Sniff Gets Right

Before proposing changes, it's important to name what's working — these are strengths to protect, not fix:

1. **Zero friction.** No sign-up, no paywall, no onboarding flow. You search, you get an answer. This is rare and precious.

2. **An opinionated voice.** Sniff doesn't hedge with "it depends" or "consult your vet." It tells you "this is grain padding" or "your cat doesn't need corn." This is the core differentiator. Every competitor hedges. Sniff doesn't.

3. **The emotional journey section.** The vet, Instagram, Google, Amazon pattern is not just good copywriting — it's mirror-accurate to the user's experience. It builds immediate trust by showing "this product was built by someone who went through what I'm going through."

4. **Craft and delight.** The cat animation, the paw cursor trail, the "pspsps" easter egg, the walking tail in the footer — these are not gimmicks. They signal care. They say "the person who built this loves cats." That matters for trust.

5. **Sharable reports.** The OG image generation + clean share URLs make Sniff social-ready. Cat parents are sharers. This is organic growth infrastructure.

---

## The Core Gap: Sniff Diagnoses But Doesn't Prescribe

This is the single most important insight in this analysis.

Sniff's current flow:
```
User arrives → Searches a food → Gets analysis → ... leaves
```

The user learns their food is "Not ideal daily" with a worry level of 2/3. They see that the first ingredient is cereals, taurine isn't disclosed, carbs are at 38%. The analysis is honest and clear.

**And then nothing.**

The user is now more anxious than when they arrived. They know their food has problems, but they don't know what to buy instead. They have a diagnosis without a prescription.

This is the equivalent of a doctor saying "your cholesterol is too high" and then saying "ok, bye." The most valuable moment in the user journey — the moment where trust converts to action — is completely unserved.

**Why this matters:** The user's job-to-be-done is confidence, not knowledge. Knowledge without a path forward creates more anxiety, not less. Sniff needs to close the loop.

---

## Five Improvements, Ordered by Impact

### 1. "What should I feed instead?" — The Recommendation Engine

**The problem:** After learning their food scores poorly, the user's immediate question is "so what should I buy?" Sniff has 196+ products analyzed. The data exists. But there's no way to surface it.

**What to build:**
- When a product gets a "Not ideal" or "Caution" verdict, show a section at the bottom: **"Better options in the same budget"**
- Surface 2-3 alternatives that score higher, filtered by:
  - Same category (dry food → dry food, wet food → wet food)
  - Similar or lower price range
  - Available in India
- Each alternative shows: brand, verdict label, protein DM%, price/day, and a one-line reason ("Named chicken is first ingredient. Taurine disclosed.")
- Link to the full Sniff analysis of each alternative

**Why this is #1:** This is the difference between a tool and a product. A tool tells you what's wrong. A product helps you fix it. This is where Sniff goes from "I used it once" to "I recommend it to everyone." It also dramatically increases engagement — every recommendation click is another product view, another share opportunity.

**What to protect:** Don't rank or endorse. Show the data. Let the user decide. The moment Sniff starts "recommending" brands, it risks looking like every other affiliate site. Instead, frame it as: "Here's what scores better in the same price range." The user draws their own conclusion.

---

### 2. "My Cat" Profile — Make the Analysis Personal

**The problem:** Every analysis is calculated for a "4kg indoor adult cat." But cats are wildly different. A 7-month kitten has different needs than a 10-year-old with early kidney disease. A 6kg outdoor cat needs different calories than a 3.5kg indoor cat.

**The current state:** The overlay shows "Analyzed for: Healthy adult indoor cat / 4kg, default profile" — but there's no way to change this.

**What to build:**
- A lightweight profile picker (not a full sign-up — stays true to no-friction ethos):
  - **Life stage:** Kitten / Adult / Senior
  - **Weight:** slider or input (2-10kg)
  - **Indoor/Outdoor**
  - **Any conditions?** (optional: kidney, urinary, digestive, none)
- Stored in localStorage (no account needed)
- Adjusts:
  - Daily portion calculation
  - Price per day
  - "Fits if / Doesn't fit if" section (a kidney-sensitive cat gets different fit criteria)
  - Best use recommendations (a kitten food rated "good for adult" might be wrong for a kitten)

**Why this is #2:** Personalization turns a generic report into *my* report. When the analysis says "this food is okay for your 3kg indoor kitten with no health issues," it feels like it was written for you. That's the difference between information and advice. It also makes the "Fits if" section — currently the least actionable part of the report — dramatically more useful.

**Design note:** The profile should be optional. Don't gate the experience. Show the default analysis, with a subtle "Adjust for your cat →" link that opens the profile picker inline.

---

### 3. Compare Two Foods Side-by-Side

**The problem:** The most common real-world scenario is: "My vet said Royal Canin, Instagram said Orijen, I'm currently feeding Whiskas. Which one should I actually pick?" This requires comparing foods, and Sniff only shows one at a time.

**What to build:**
- A "Compare" button on the analysis report
- Opens a split-view (or stacked view on mobile) showing two foods
- Key comparison points:
  - Verdict label (side by side)
  - Protein DM% bar (overlaid)
  - Carbs % bar (overlaid)
  - Price per day
  - Worry level
  - Key differences highlighted ("Food A discloses taurine, Food B doesn't")
- A one-line summary: "Food A is higher in protein, lower in carbs, and ₹12/day cheaper. Both lack ash disclosure."

**Why this is #3:** Comparison is how humans make decisions. Not by evaluating one option in isolation, but by evaluating it *against* alternatives. This is especially true for purchases. No one buys cat food without mentally (or explicitly) comparing it to what they're currently using.

**Scope note:** This doesn't need to be a full-featured comparison matrix. Two foods, key metrics, one summary line. Keep it simple.

---

### 4. Food Transition Guide — "How to Switch Safely"

**The problem:** A user learns their food is "Not ideal" and finds a better option through recommendation (#1) or comparison (#3). Now they need to switch. But cats can't switch food overnight — abrupt changes cause digestive issues (vomiting, diarrhea). Most cat parents don't know this, and those who do don't know the right timeline.

**What to build:**
- When a user views a food after having a recent view history (meaning they're likely comparing/switching), show a small section: **"Switching? Here's how"**
- A simple 7-day transition timeline:
  - Day 1-2: 75% old food / 25% new food
  - Day 3-4: 50/50
  - Day 5-6: 25% old / 75% new
  - Day 7+: 100% new food
- Visual: a simple horizontal bar showing the blend ratio per phase
- Note: "If your cat shows digestive issues, slow down. Extend each phase to 3 days."

**Why this is #4:** This is a "delight" feature that shows Sniff cares about outcomes, not just analysis. It costs almost nothing to build (it's static content) but signals that Sniff understands the full journey: discover → evaluate → decide → transition → monitor.

**Implementation:** This can be static HTML/CSS — no API call needed. Show it contextually when it's relevant (not on every page).

---

### 5. "Ask Sniff" — Natural Language Questions

**The problem:** Not every user arrives with a specific product in mind. Some arrive with questions:
- "What's a good dry food under ₹50/day?"
- "My cat has kidney issues, what should I avoid?"
- "Is grain-free actually better?"
- "My kitten is 4 months old, what should I feed?"

The current search box only works for product names. These questions get routed to Claude via the API fallback, but the response is a single-product analysis — not an answer to the question.

**What to build:**
- Detect when the user's query is a question (contains "what," "which," "is," "should," "best," "good," "recommend," etc.)
- Route to a different Claude prompt that answers the question using Sniff's voice and the product database
- Response format: conversational answer (2-4 sentences) + 2-3 relevant product cards
- Example: "What's a good wet food for kittens under ₹80/100g?"
  → "For kittens, you want high protein, named meat first, and taurine disclosed. At that price point, Farmina Kitten Chicken and Royal Canin Kitten Instinctive both score well. Farmina edges it on transparency — they actually tell you what's in it."

**Why this is #5 (and not higher):** This is a powerful feature but has higher complexity (new prompt engineering, response format, edge cases). It also shifts the product from "food analyzer" to "cat nutrition advisor" — which is the right long-term direction but needs careful execution to maintain the honest, non-corporate voice.

**Risk to manage:** LLM hallucination. If Claude recommends a product that doesn't exist in India or gives wrong nutritional data, trust is destroyed. Mitigate by grounding responses in the existing Supabase product database rather than relying on Claude's training data alone.

---

## What NOT to Build

These are common product impulses that would hurt Sniff:

**User accounts and sign-up.** The zero-friction entry is Sniff's superpower. The moment you add "create an account to save your favorites," you lose 60%+ of first-time users. localStorage is enough for now. If profiles (#2) need persistence, consider anonymous device tokens — not email/password auth.

**Scores or rankings.** "4.2 out of 5" or "Ranked #3 in dry food" creates a false precision that undermines the honest voice. Sniff's verdict labels (Strong choice / Good enough / Not ideal) are more honest and more useful than numerical scores.

**Affiliate links or "Buy on Amazon" CTAs.** The moment Sniff makes money from product recommendations, every recommendation becomes suspect. The trust advantage disappears. If monetization is needed, explore alternatives: premium features for breeders/catteries, B2B API for pet stores, or voluntary support (like Wikipedia).

**A mobile app.** A web app that works well on mobile is better than a native app for this use case. Cat parents don't need Sniff daily — they need it at decision moments. A website is always one search away. An app requires download, updates, storage. The current responsive web experience is the right call.

**Community features (comments, reviews, ratings).** User-generated content requires moderation, fights misinformation, and dilutes the authoritative voice. Sniff's strength is *one* honest analysis per product, not 500 conflicting opinions. That's what Amazon is for.

---

## Prioritization Summary

| # | Improvement | User Impact | Build Effort | Why Now |
|---|-----------|------------|-------------|---------|
| 1 | Recommendation engine | Very High | Medium | Closes the biggest gap in the user journey — turns diagnosis into action |
| 2 | Cat profile | High | Low-Medium | Makes every analysis personal; multiplies perceived value of existing content |
| 3 | Compare two foods | High | Medium | Matches how humans actually make purchase decisions |
| 4 | Transition guide | Medium | Very Low | Static content, high delight, signals Sniff cares about outcomes |
| 5 | Ask Sniff (NL questions) | High | High | Expands the product from analyzer to advisor — right direction, needs careful execution |

---

## The Strategic Frame

Sniff is currently a **diagnostic tool**: you bring it a food, it tells you if it's good.

The improvements above move it toward being a **decision companion**: you come with doubt, you leave with a plan.

The user's journey should become:
```
Doubt → Search → Understand (analysis) → Decide (compare + recommend) → Act (transition guide) → Confidence
```

Right now, Sniff covers steps 1-3. The gap is steps 4-6. Closing that gap is the difference between "a cool tool I used once" and "the thing I tell every cat parent about."

---

*Analysis by Claude, based on full codebase review and first-principles reasoning about the Indian cat parent user.*
*May 2025*
