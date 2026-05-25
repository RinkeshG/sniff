export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query } = req.body;
  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return res.status(400).json({ error: 'Please enter a product name' });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const searchResults = await webSearch(query.trim());

  const prompt = buildPrompt(query.trim(), searchResults);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', err);
      return res.status(502).json({ error: 'Analysis service unavailable' });
    }

    const data = await response.json();
    const text = data.content[0].text;

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(502).json({ error: 'Could not parse analysis' });
    }

    const result = JSON.parse(jsonMatch[0]);
    return res.status(200).json(result);
  } catch (err) {
    console.error('Sniff API error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

async function webSearch(query) {
  const braveKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!braveKey) return '';

  try {
    const searchQuery = `${query} cat food ingredients guaranteed analysis nutrition`;
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(searchQuery)}&count=5`;
    const response = await fetch(url, {
      headers: { 'X-Subscription-Token': braveKey, Accept: 'application/json' },
    });

    if (!response.ok) return '';

    const data = await response.json();
    const results = (data.web?.results || []).slice(0, 5);
    return results
      .map((r) => `[${r.title}]\n${r.description}`)
      .join('\n\n');
  } catch {
    return '';
  }
}

function buildPrompt(query, searchResults) {
  const searchSection = searchResults
    ? `\n\nWEB SEARCH RESULTS for "${query}":\n${searchResults}\n`
    : '';

  return `You are Sniff's analysis engine. A cat parent in India just typed "${query}" into the search bar.

Your job:
1. Figure out what product this is
2. Research its ingredients, guaranteed analysis, and nutritional profile
3. Generate an honest, opinionated analysis

${searchSection}

IMPORTANT CLASSIFICATION:
First, determine what type of product this is:
- "cat" — it's a cat food product → generate full analysis
- "dog" — it's a dog food product → return dog food response
- "not_food" — it's not a pet food at all → return not_food response
- "not_found" — you can't find enough reliable data → return not_found response

If the query is vague (just a brand name like "Whiskas"), pick their most popular/common product in India.

SCORING METHODOLOGY (be opinionated, not diplomatic):
- Cats are obligate carnivores. They need meat, not grains.
- First ingredient should be a named meat (chicken, tuna, salmon). "Cereals" or "meat by-products" first = red flag.
- Carbs: wild cats eat ~5%. Anything above 25% is high. Above 35% is grain padding.
- Protein dry matter: below 30% = barely passing. 30-40% = acceptable. 40-50% = good. 50%+ = excellent.
- Taurine must be disclosed. If not, it's a transparency failure.
- Ash content above 8% suggests low-quality ingredients.
- Ca:P ratio should be 1:1 to 2:1. If not disclosed, that's a gap.
- Named meat source vs generic "meat by-products" or "animal derivatives" — always flag generic.
- Ingredient splitting (listing cereals, cereal by-products, wheat, corn separately to push them down the list) = deceptive.
- Wet food is generally closer to what cats naturally eat (high moisture, higher protein DM, lower carbs).

VERDICT LABELS (pick the most honest one):
- "Strong choice" — genuinely good, transparent, close to what cats need
- "Good enough" — decent option, reasonable transparency
- "Okay for now" — won't harm a healthy cat short-term, but has gaps
- "Not ideal daily" — too many gaps for confident long-term daily use
- "Not transparent enough" — can't judge properly because the brand hides too much
- "Caution" — real concerns about quality or suitability

WORRY LEVELS:
- "low" (filled: 1) — nothing alarming, minor gaps at most
- "medium" (filled: 2) — notable gaps in transparency or nutrition
- "high" (filled: 3) — real concerns about quality, ingredients, or suitability

YOUR VOICE:
- You're a knowledgeable cat parent talking to another parent. Not a nutritionist giving a lecture.
- Be direct. "Your cat doesn't need corn" not "corn may not be optimal for feline nutrition."
- The "parentTake" field is the heart of the product. Write it like you're texting a friend who asked "should I feed this?"
- Don't hedge everything. Have a point of view.
- Don't say "consult your vet" for every little thing. Only for genuine health conditions.

RESPONSE FORMAT — return ONLY valid JSON, no markdown, no explanation:

For type "cat":
{
  "type": "cat",
  "brand": "Brand · Type (Dry food / Wet food / Treat)",
  "title": "Product variant name",
  "price": "₹XX/100g · ≈ ₹XX/day for a 4kg indoor cat",
  "verdict": {
    "label": "One of the verdict labels above",
    "tag": "Short qualifier (e.g. 'Low transparency', 'Decent option')",
    "labelClass": "vp-good | vp-okay | vp-weak",
    "tagClass": "vp-good | vp-muted",
    "summary": "2-3 sentences. The honest take on this food. Decision-oriented, not technical."
  },
  "worry": {
    "level": "low | medium | high",
    "filled": 1-3,
    "label": "Low concern | Medium concern | Higher concern",
    "note": "1-2 sentences explaining what to actually worry about (or not)."
  },
  "action": "2-3 sentences. Concrete next steps. What to do right now + before next purchase.",
  "reasons": [
    { "status": "good | caution | missing", "q": "Short finding as a question-answer (e.g. 'Enough protein? Yes.')", "a": "1-2 sentence explanation." },
    { "status": "good | caution | missing", "q": "...", "a": "..." },
    { "status": "good | caution | missing", "q": "...", "a": "..." }
  ],
  "bestUse": [
    { "q": "Daily base food?", "a": "Yes / Maybe / Not ideal / Only if budget-limited", "cls": "bu-good | bu-okay | bu-flag | bu-vet" },
    { "q": "Backup food?", "a": "...", "cls": "..." },
    { "q": "For picky cats?", "a": "...", "cls": "..." },
    { "q": "Kidney / urinary?", "a": "Ask vet first / Good option / etc", "cls": "bu-vet | bu-good | bu-okay" }
  ],
  "parentTake": "3-4 sentences. This is the most important field. Write like you're talking to a friend. What would YOU do if this were your cat's food? Be specific and honest.",
  "f1": { "type": "co | ws | gm", "label": "Checks out | Worth a sniff | Gone missing", "val": 33, "unit": "%", "what": "Protein (DM)", "tip": "Short explanation" },
  "f2": { "type": "co | ws | gm", "label": "Checks out | Worth a sniff | Gone missing", "val": 39, "prefix": "≈", "unit": "%", "what": "Carbs (calc)", "tip": "Short explanation" },
  "f3": { "type": "co | ws | gm", "label": "Checks out | Worth a sniff | Gone missing", "val": "0.14%" OR "text": "not disclosed", "what": "Taurine | Hydration | other key metric", "tip": "Short explanation" },
  "barPos": 41,
  "barLabel": "← 33% here",
  "ing": "First ingredient name",
  "ingRest": "then: rest of key ingredients. <strong>Commentary on ingredient quality.</strong>",
  "missing": [["Nutrient name", "Not disclosed"], ["...", "..."]],
  "nose": "2-3 sentences. The Sniff summary — punchy, direct, opinionated. Think closing argument."
}

For type "dog":
{
  "type": "dog",
  "brand": "Brand name",
  "title": "Product name"
}

For type "not_food":
{
  "type": "not_food",
  "query": "${query}"
}

For type "not_found":
{
  "type": "not_found",
  "query": "${query}",
  "suggestion": "A brief suggestion of what to search instead, or null"
}

CRITICAL:
- For price, use Indian Rupees (₹). Research actual Indian market prices.
- Calculate protein on dry matter basis: protein% / (100 - moisture%) × 100
- Calculate estimated carbs: 100 - protein - fat - fibre - moisture - ash (estimate ash at 7-8% if not disclosed)
- Return ONLY the JSON object. No markdown fences, no explanation text before or after.
- If you're not confident about specific numbers, use reasonable estimates based on similar products and note the uncertainty.
- For f3, use "val" for known values (like "0.14%") and "text" for unknown ones (like "not disclosed"). Never include both.`;
}
