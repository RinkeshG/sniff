#!/usr/bin/env node

/**
 * Seed script: generates Sniff analysis for popular Indian cat foods.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node scripts/seed.js
 *
 * Reads existing foods.json, generates missing entries, writes back.
 * Safe to re-run — skips products that already exist.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FOODS_PATH = resolve(__dirname, '..', 'foods.json');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY) {
  console.error('Set ANTHROPIC_API_KEY environment variable');
  process.exit(1);
}

const PRODUCTS = [
  // -- Dry food --
  'Whiskas Ocean Fish Adult',
  'Whiskas Tuna Adult',
  'Whiskas Chicken Adult',
  'Whiskas Junior Ocean Fish Kitten',
  'Royal Canin Indoor Adult',
  'Royal Canin Kitten',
  'Royal Canin Fit 32',
  'Royal Canin Urinary Care',
  'Royal Canin Hair & Skin Care',
  'Me-O Tuna Adult',
  'Me-O Ocean Fish Adult',
  'Me-O Chicken & Vegetable Adult',
  'Me-O Persian Adult',
  'Me-O Kitten',
  'Drools Ocean Fish Adult',
  'Drools Chicken Adult Cat',
  'Purepet Ocean Fish Adult',
  'Purepet Tuna & Salmon Kitten',
  'IAMS Proactive Health Adult',
  'IAMS Proactive Health Kitten',
  'Farmina N&D Chicken & Pomegranate Adult',
  'Farmina N&D Lamb & Blueberry Adult',
  'Farmina Matisse Chicken & Rice',
  'Farmina Matisse Kitten',
  'Orijen Cat & Kitten',
  'Acana Pacifica Cat',
  'Acana Grasslands Cat',
  'Hills Science Diet Indoor Adult',
  'Hills Science Diet Kitten',
  'Josera Catelux Adult',
  'Josera Kitten',
  'Canidae Pure Indoor',
  'Taste of the Wild Rocky Mountain',
  'N&D Quinoa Urinary Duck',
  // -- Wet food --
  'Sheba Tuna in Jelly',
  'Sheba Chicken in Gravy',
  'Sheba Tuna & Salmon in Gravy',
  'Sheba Skipjack & Salmon',
  'Whiskas Tuna in Jelly Wet',
  'Whiskas Ocean Fish in Gravy Wet',
  'Whiskas Chicken in Gravy Wet',
  'Royal Canin Instinctive Gravy',
  'Royal Canin Kitten Gravy',
  'Me-O Tuna in Jelly Wet',
  'Me-O Sardine in Jelly Wet',
  'Purepet Tuna & Chicken Wet',
  'Applaws Tuna Fillet',
  'Felix Fish Selection in Jelly',
  'Fancy Feast Grilled Tuna',
  'Farmina N&D Chicken & Pomegranate Wet',
];

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function generateAnalysis(productName) {
  const prompt = `You are Sniff's analysis engine. Generate a detailed analysis for this Indian cat food product: "${productName}"

SCORING METHODOLOGY (be opinionated, not diplomatic):
- Cats are obligate carnivores. They need meat, not grains.
- First ingredient should be a named meat. "Cereals" or "meat by-products" first = red flag.
- Carbs: wild cats eat ~5%. Above 25% is high. Above 35% is grain padding.
- Protein dry matter: below 30% = barely passing. 30-40% = acceptable. 40-50% = good. 50%+ = excellent.
- Taurine must be disclosed. If not, it's a transparency failure.
- Ca:P ratio should be 1:1 to 2:1. If not disclosed, that's a gap.
- Named meat source vs generic "by-products" — always flag generic.
- Wet food is generally closer to what cats naturally eat.

VERDICT LABELS (pick one): "Strong choice", "Good enough", "Okay for now", "Not ideal daily", "Not transparent enough", "Caution"
WORRY LEVELS: "low" (filled: 1), "medium" (filled: 2), "high" (filled: 3)

YOUR VOICE: Direct, opinionated, like a knowledgeable cat parent talking to another parent. The "parentTake" is the heart — write it like you're texting a friend.

Return ONLY valid JSON (no markdown fences):
{
  "type": "cat",
  "brand": "Brand · Type (Dry food / Wet food)",
  "title": "Product variant name",
  "price": "₹XX/100g · ≈ ₹XX/day for a 4kg indoor cat",
  "verdict": { "label": "...", "tag": "short qualifier", "labelClass": "vp-good|vp-okay|vp-weak", "tagClass": "vp-good|vp-muted", "summary": "2-3 sentences." },
  "worry": { "level": "low|medium|high", "filled": 1-3, "label": "Low/Medium/Higher concern", "note": "1-2 sentences." },
  "action": "2-3 sentences. Concrete next steps.",
  "reasons": [
    { "status": "good|caution|missing", "q": "Short finding", "a": "1-2 sentence explanation." },
    { "status": "...", "q": "...", "a": "..." },
    { "status": "...", "q": "...", "a": "..." }
  ],
  "bestUse": [
    { "q": "Daily base food?", "a": "...", "cls": "bu-good|bu-okay|bu-flag|bu-vet" },
    { "q": "Backup food?", "a": "...", "cls": "..." },
    { "q": "For picky cats?", "a": "...", "cls": "..." },
    { "q": "Kidney / urinary?", "a": "...", "cls": "bu-vet|bu-good|bu-okay" }
  ],
  "parentTake": "3-4 sentences. What would YOU do?",
  "f1": { "type": "co|ws|gm", "label": "Checks out|Worth a sniff|Gone missing", "val": number, "unit": "%", "what": "Protein (DM)", "tip": "..." },
  "f2": { "type": "co|ws|gm", "label": "...", "val": number, "prefix": "≈", "unit": "%", "what": "Carbs (calc)", "tip": "..." },
  "f3": { "type": "co|ws|gm", "label": "...", "val": "0.14%" OR "text": "not disclosed", "what": "Taurine|Hydration|...", "tip": "..." },
  "barPos": number (0-100, where protein sits on a 26-50%+ scale),
  "barLabel": "← XX% here",
  "ing": "First ingredient name",
  "ingRest": "then: rest of ingredients. <strong>Commentary.</strong>",
  "missing": [["Nutrient", "Not disclosed"], ...],
  "nose": "2-3 sentences. Punchy summary."
}

Use Indian Rupee prices (₹). Calculate protein on dry matter basis. Estimate carbs as 100 - protein - fat - fibre - moisture - ash. Return ONLY the JSON.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`API error for "${productName}": ${err}`);
  }

  const data = await resp.json();
  const text = data.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in response for "${productName}"`);
  return JSON.parse(jsonMatch[0]);
}

async function main() {
  let db = {};
  try {
    db = JSON.parse(readFileSync(FOODS_PATH, 'utf-8'));
  } catch {
    console.log('No existing foods.json, starting fresh.');
  }

  const existing = Object.keys(db).length;
  console.log(`Found ${existing} existing products.`);

  const toGenerate = PRODUCTS.filter((p) => !db[slugify(p)]);
  console.log(`Generating ${toGenerate.length} new products...`);

  for (let i = 0; i < toGenerate.length; i++) {
    const name = toGenerate[i];
    const slug = slugify(name);
    console.log(`[${i + 1}/${toGenerate.length}] ${name}...`);

    try {
      const result = await generateAnalysis(name);
      db[slug] = result;
      writeFileSync(FOODS_PATH, JSON.stringify(db, null, 2));
      console.log(`  ✓ saved`);
    } catch (err) {
      console.error(`  ✗ ${err.message}`);
    }

    // rate limit: ~1 req/sec
    if (i < toGenerate.length - 1) {
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  console.log(`\nDone. ${Object.keys(db).length} products in foods.json`);
}

main();
