#!/usr/bin/env node

/**
 * Seed script: generates Sniff analysis for Indian cat food products.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node scripts/seed.js
 *
 * Optional flags:
 *   --only="brand keyword"     only process products matching keyword
 *   --limit=N                  process only first N matching products
 *   --resume                   skip products already in foods.json (default behavior)
 *
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

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith('--only='))?.split('=')[1];
const limitArg = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] || '0', 10);

// ─────────────────────────────────────────────────────────────
// COMPREHENSIVE PRODUCT LIST — Indian cat food market
// Organized by category. Real product variants, not made up.
// ─────────────────────────────────────────────────────────────

const PRODUCTS = [
  // ═══ DRY FOOD — ADULT ═══
  // Whiskas (Mars India)
  'Whiskas Ocean Fish Adult 1+',
  'Whiskas Tuna Adult 1+',
  'Whiskas Chicken Adult 1+',
  'Whiskas Mackerel Adult',

  // Royal Canin (massive range in India)
  'Royal Canin Indoor Adult',
  'Royal Canin Indoor Long Hair',
  'Royal Canin Outdoor Adult',
  'Royal Canin Persian Adult',
  'Royal Canin British Shorthair Adult',
  'Royal Canin Maine Coon Adult',
  'Royal Canin Sterilised Adult',
  'Royal Canin Fit 32 Adult',
  'Royal Canin Sensible 33 Adult',
  'Royal Canin Hair & Skin Care',
  'Royal Canin Digestive Care',
  'Royal Canin Urinary Care',
  'Royal Canin Ageing 12+ Senior',

  // Me-O (Perfect Companion)
  'Me-O Tuna Adult',
  'Me-O Ocean Fish Adult',
  'Me-O Chicken & Vegetable Adult',
  'Me-O Persian Adult',
  'Me-O Hairball Control Adult',
  'Me-O Anti-Hairball',

  // Drools
  'Drools Ocean Fish Adult Cat',
  'Drools Chicken Adult Cat',
  'Drools Salmon Adult Cat',

  // Purepet
  'Purepet Ocean Fish Adult Cat',
  'Purepet Tuna Adult Cat',

  // IAMS
  'IAMS Proactive Health Adult Original with Chicken',
  'IAMS Proactive Health Indoor Weight & Hairball Care',
  'IAMS Proactive Health Mature Adult',
  'IAMS Proactive Health Healthy Senior',
  'IAMS Hairball Care Adult',

  // Farmina N&D (Ancestral Grain - Quinoa line)
  'Farmina N&D Ancestral Grain Chicken & Pomegranate Adult',
  'Farmina N&D Ancestral Grain Lamb & Blueberry Adult',
  'Farmina N&D Ancestral Grain Boar & Apple Adult',
  'Farmina N&D Ancestral Grain Cod & Orange Adult',

  // Farmina N&D Grain-Free
  'Farmina N&D Grain-Free Chicken & Pomegranate Adult',
  'Farmina N&D Grain-Free Lamb & Blueberry Adult',
  'Farmina N&D Grain-Free Pumpkin Quail Adult',
  'Farmina N&D Grain-Free Wild Boar Adult',
  'Farmina N&D Quinoa Urinary Duck',
  'Farmina N&D Quinoa Skin & Coat Quail',

  // Farmina Matisse
  'Farmina Matisse Chicken & Rice',
  'Farmina Matisse Salmon & Tuna',
  'Farmina Matisse Persian Adult',
  'Farmina Matisse Senior',

  // Orijen (Champion Petfoods)
  'Orijen Cat & Kitten',
  'Orijen Fit & Trim',
  'Orijen Six Fish Cat',
  'Orijen Tundra Cat',
  'Orijen Regional Red Cat',

  // Acana
  'Acana Pacifica Cat',
  'Acana Grasslands Cat',
  'Acana Wild Prairie Cat',
  'Acana Bountiful Catch',
  'Acana Indoor Entrée',
  'Acana Homestead Harvest',

  // Hills Science Diet
  'Hills Science Diet Adult Indoor Chicken',
  'Hills Science Diet Sensitive Stomach & Skin Adult',
  'Hills Science Diet Hairball Control Adult',
  'Hills Science Diet Mature Adult 7+',
  'Hills Science Diet Light Adult',
  'Hills Science Diet Perfect Weight Adult',

  // Hills Prescription Diet
  'Hills Prescription Diet c/d Multicare Urinary Care',
  'Hills Prescription Diet k/d Kidney Care',
  'Hills Prescription Diet z/d Sensitive Skin',
  'Hills Prescription Diet w/d Digestive Weight',
  'Hills Prescription Diet i/d Digestive Care',

  // Josera
  'Josera Catelux Adult',
  'Josera Léon Adult',
  'Josera Daily Cat',
  'Josera Carismo Senior',
  'Josera Naturecat',

  // Smart Heart
  'Smart Heart Adult Cat Mackerel',
  'Smart Heart Adult Cat Tuna',
  'Smart Heart Gold Adult',

  // Indian / emerging brands
  'Henlo Cat Food Salmon',
  'Henlo Cat Food Chicken',
  'Kennel Kitchen Cat Food Chicken & Rice',
  'Carniwel Adult Cat Chicken',
  'Symply Adult Cat Chicken',
  'Symply Senior Cat',
  'Applaws Adult Cat Dry Chicken',
  'Applaws Senior Cat Dry',
  'Applaws Kitten Dry Chicken',
  'Cibau Adult Cat',
  'Reflex Plus Adult Cat Salmon',
  'Reflex Adult Cat Chicken',

  // ═══ DRY FOOD — KITTEN ═══
  'Whiskas Junior Ocean Fish Kitten 2-12 months',
  'Whiskas Junior Mackerel Kitten',
  'Royal Canin Mother & Babycat',
  'Royal Canin Kitten 4-12 months',
  'Royal Canin Persian Kitten',
  'Royal Canin British Shorthair Kitten',
  'Me-O Kitten Tuna',
  'Me-O Kitten Chicken',
  'Drools Kitten Ocean Fish',
  'Drools Kitten Chicken',
  'Purepet Tuna & Salmon Kitten',
  'IAMS Proactive Health Kitten',
  'Farmina N&D Kitten Chicken & Pomegranate',
  'Farmina N&D Kitten Cod & Orange',
  'Farmina Matisse Kitten',
  'Acana First Feast Kitten',
  'Hills Science Diet Kitten Healthy Development',
  'Josera Kitten',
  'Smart Heart Kitten',
  'Henlo Kitten',

  // ═══ WET FOOD — POUCHES & CANS ═══
  // Sheba (Mars - flagship wet food in India)
  'Sheba Tuna in Jelly',
  'Sheba Chicken in Gravy',
  'Sheba Tuna & Salmon in Gravy',
  'Sheba Skipjack & Salmon',
  'Sheba Chicken with Tuna',
  'Sheba Surimi & Snapper',
  'Sheba Pacific Pollock & Crab',
  'Sheba Tuna Loaf',
  'Sheba Chicken Loaf',

  // Whiskas Wet
  'Whiskas Tuna in Jelly Wet Pouch',
  'Whiskas Ocean Fish in Gravy Wet Pouch',
  'Whiskas Chicken in Gravy Wet Pouch',
  'Whiskas Mackerel in Gravy Wet Pouch',

  // Royal Canin Wet
  'Royal Canin Instinctive Gravy Adult Wet',
  'Royal Canin Kitten Instinctive Wet',
  'Royal Canin Sterilised Wet',
  'Royal Canin Ageing 12+ Wet',
  'Royal Canin Persian Adult Wet',

  // Me-O Wet
  'Me-O Tuna in Jelly Wet Pouch',
  'Me-O Sardine in Jelly Wet Pouch',
  'Me-O Tuna & Salmon Wet Pouch',
  'Me-O Tuna & Whitefish Wet Pouch',

  // Applaws (premium wet — huge range)
  'Applaws Tuna Fillet',
  'Applaws Tuna Fillet with Pacific Prawn',
  'Applaws Chicken Breast in Broth',
  'Applaws Chicken Breast with Cheese',
  'Applaws Sardine with Mackerel',
  'Applaws Sardine with Shrimp',
  'Applaws Salmon Fillet',
  'Applaws Mackerel with Sardine',
  'Applaws Tuna with Mussel',
  'Applaws Tuna with Crab',
  'Applaws Tuna with Salmon',
  'Applaws Ocean Fish',
  'Applaws Chicken with Pumpkin',

  // Felix (Purina/Nestle)
  'Felix Fish Selection in Jelly',
  'Felix Meat Selection in Jelly',

  // Fancy Feast (Purina)
  'Fancy Feast Grilled Tuna',
  'Fancy Feast Grilled Chicken',
  'Fancy Feast Classic Pâté Salmon',
  'Fancy Feast Classic Pâté Liver & Chicken',
  'Fancy Feast Flaked Tuna',

  // Schesir
  'Schesir Tuna with Sea Bream',
  'Schesir Chicken with Beef',
  'Schesir Tuna with Aloe',
  'Schesir Tuna with Surimi',

  // Almo Nature
  'Almo Nature HQS Natural Tuna',
  'Almo Nature HQS Natural Chicken',
  'Almo Nature Daily Tuna',
  'Almo Nature Functional Sensitive',

  // Farmina N&D Wet
  'Farmina N&D Wet Chicken & Pomegranate',
  'Farmina N&D Wet Lamb & Blueberry',
  'Farmina N&D Wet Codfish & Pumpkin',

  // Purepet Wet
  'Purepet Tuna & Chicken Wet Pouch',

  // ═══ TREATS ═══
  // Whiskas Temptations
  'Whiskas Temptations Tasty Chicken',
  'Whiskas Temptations Seafood Medley',
  'Whiskas Temptations Salmon',

  // Sheba treats
  'Sheba Catch Tuna',
  'Sheba Catch Chicken',

  // Me-O treats
  'Me-O Creamy Treat Tuna',
  'Me-O Creamy Treat Chicken',

  // Inaba Churu (massive variety)
  'Inaba Churu Tuna Recipe',
  'Inaba Churu Chicken Recipe',
  'Inaba Churu Tuna & Salmon',
  'Inaba Churu Tuna & Chicken',
  'Inaba Churu Chicken with Cheese',
  'Inaba Churu Tuna Variety Pack',

  // Catit
  'Catit Creamy Tuna Treat',
  'Catit Creamy Salmon Treat',
  'Catit Creamy Chicken Treat',

  // Dreamies (Mars)
  'Dreamies Tuna Treats',
  'Dreamies Chicken Treats',
  'Dreamies Salmon Treats',
  'Dreamies Cheese Treats',

  // Friskies
  'Friskies Party Mix Original Crunch',
  'Friskies Party Mix Beachside Crunch',
  'Friskies Party Mix Picnic Crunch',

  // GoofyTails (Indian natural treats brand)
  'GoofyTails Cat Treats Salmon',
  'GoofyTails Cat Treats Tuna',
  'GoofyTails Cat Treats Chicken',
  'GoofyTails Catnip Cat Treats',

  // Petsy
  'Petsy Cat Treats Chicken',
  'Petsy Cat Treats Salmon',

  // Wiggles
  'Wiggles Cat Treats',

  // Temptations Mix-ups
  'Temptations Mixups Catnip Fever',
  'Temptations Mixups Surfers Delight',

  // Vitakraft / Premium treats
  'Vitakraft Crispy Crunch Cat Treats',
];

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function generateAnalysis(productName) {
  const prompt = `You are Sniff's analysis engine. Generate a detailed analysis for this Indian cat food product: "${productName}"

If you don't have reliable information about this exact product, return:
{ "type": "not_found", "query": "${productName}" }

If this is a dog product, return:
{ "type": "dog", "brand": "Brand", "title": "Product" }

SCORING METHODOLOGY (be opinionated, not diplomatic):
- Cats are obligate carnivores. They need meat, not grains.
- First ingredient should be a named meat. "Cereals" or "by-products" first = red flag.
- Carbs: wild cats eat ~5%. Above 25% is high. Above 35% is grain padding.
- Protein dry matter: below 30% = barely passing. 30-40% = acceptable. 40-50% = good. 50%+ = excellent.
- Taurine must be disclosed. If not, it's a transparency failure.
- Ca:P ratio should be 1:1 to 2:1. If not disclosed, that's a gap.
- Named meat source vs generic "by-products" — always flag generic.
- Wet food is generally closer to what cats naturally eat (high moisture, higher protein DM, lower carbs).
- Treats are NOT meals — judge them on whether they're occasional indulgences (acceptable) or filler junk.

VERDICT LABELS (pick one): "Strong choice", "Good enough", "Okay for now", "Not ideal daily", "Not transparent enough", "Caution"
WORRY LEVELS: "low" (filled: 1), "medium" (filled: 2), "high" (filled: 3)

YOUR VOICE: Direct, opinionated. Like a knowledgeable cat parent talking to another parent. The "parentTake" is the heart — write it like you're texting a friend.

For treats specifically:
- Frame the verdict around "use as a treat" not "daily food"
- Highlight if it has artificial colors, sugar, or excessive fillers
- For freeze-dried/single-ingredient treats (like Churu), call that out as a positive
- "Best use" should reflect that this is a treat, not a meal

Return ONLY valid JSON (no markdown fences):
{
  "type": "cat",
  "brand": "Brand · Type (Dry food / Wet food / Treat)",
  "title": "Product variant name",
  "price": "₹XX/100g · ≈ ₹XX/day for a 4kg indoor cat (or per treat session for treats)",
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

For treats, "Daily base food?" should be "Not a meal" or "Treat only" (cls: bu-flag or bu-okay).

Use Indian Rupee prices. Calculate protein on dry matter basis. Return ONLY the JSON.`;

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
    throw new Error(`API error: ${err}`);
  }

  const data = await resp.json();
  const text = data.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response');
  return JSON.parse(jsonMatch[0]);
}

async function main() {
  let db = {};
  try {
    db = JSON.parse(readFileSync(FOODS_PATH, 'utf-8'));
  } catch {
    console.log('No existing foods.json, starting fresh.');
  }

  let queue = PRODUCTS.filter((p) => !db[slugify(p)]);

  if (onlyArg) {
    const filter = onlyArg.toLowerCase();
    queue = queue.filter((p) => p.toLowerCase().includes(filter));
    console.log(`Filtered by "${onlyArg}": ${queue.length} products`);
  }

  if (limitArg > 0) {
    queue = queue.slice(0, limitArg);
    console.log(`Limited to first ${limitArg} products`);
  }

  console.log(`\n${Object.keys(db).length} existing in foods.json`);
  console.log(`${queue.length} to generate\n`);

  let skipped = 0;
  let failed = 0;
  let succeeded = 0;

  for (let i = 0; i < queue.length; i++) {
    const name = queue[i];
    const slug = slugify(name);
    process.stdout.write(`[${i + 1}/${queue.length}] ${name}... `);

    try {
      const result = await generateAnalysis(name);

      if (result.type === 'cat') {
        db[slug] = result;
        writeFileSync(FOODS_PATH, JSON.stringify(db, null, 2));
        console.log(`✓ saved (${result.verdict?.label || 'unknown verdict'})`);
        succeeded++;
      } else if (result.type === 'not_found') {
        console.log(`⊘ skipped (no reliable data)`);
        skipped++;
      } else if (result.type === 'dog') {
        console.log(`⊘ skipped (dog food)`);
        skipped++;
      } else {
        console.log(`? unexpected type: ${result.type}`);
        skipped++;
      }
    } catch (err) {
      console.log(`✗ ${err.message}`);
      failed++;
    }

    // rate limit: ~1 req/sec to stay well under Anthropic's limits
    if (i < queue.length - 1) {
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  console.log(`\n────────────────────────────`);
  console.log(`Generated: ${succeeded}`);
  console.log(`Skipped:   ${skipped}`);
  console.log(`Failed:    ${failed}`);
  console.log(`Total in foods.json: ${Object.keys(db).length}`);
}

main();
