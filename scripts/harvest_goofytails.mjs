#!/usr/bin/env node
/**
 * Verify unverified Goofy Tails cat products from the brand's OWN Shopify site
 * (goofytails.com). Because each product page IS that product, matching is exact
 * by construction (no Amazon-style cross-variant guessing). The ingredient list
 * and nutrition are printed inside the product IMAGES, so we OCR the page images
 * (macOS Vision via scripts/bin/ocrtool), extract the label deterministically,
 * and run the SAME identity/consistency gate as build.js (lib/pipeline.js).
 *
 * Conviction-or-abstain: a product is only matched on an EXACT flavour identity
 * (same descriptor set + same named-meat set, cat not dog, not a variety pack).
 * A guaranteed analysis is only used if it yields a real protein %; the grams-
 * per-100g labels stay honest "partial" (ingredients-first), never a shaky GA.
 *
 * Run: ~/.nvm/versions/node/v22.17.0/bin/node scripts/harvest_goofytails.mjs
 * Writes /tmp/goofytails.sql (review before applying). NO DB writes here.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { buildAnalysis } from './lib/pipeline.js';
import { parseLabel } from './lib/parse.js';
import { NAMED_MEATS, hasNamedMeat } from './lib/constants.js';
import { classifySpecies } from './lib/identity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OCRTOOL = resolve(__dirname, 'bin/ocrtool');
const UA = { 'User-Agent': 'Mozilla/5.0 SniffBot/1.0 (+https://sniff.fyi)' };
const NOW = new Date().toISOString();

// ── The unverified Goofy Tails cat products (verbatim from the live DB) ───────
// `skip` marks the variety pack: 3-in-1 multi-flavour, no single label to assert.
const TARGETS = [
  { slug: 'goofy-tails-chicken-bone-broth-for-cats-gotdealss', brand: 'Goofy Tails · Treat', title: 'Chicken Bone Broth for Cats', category: 'treat', life_stage: 'adult', type: 'cat' },
  { slug: 'goofy-tails-freeze-dried-shrimp-cat-treats', brand: 'Goofy Tails · Treat', title: 'Freeze Dried Shrimp', category: 'treat', life_stage: 'adult', type: 'cat' },
  { slug: 'goofy-tails-freeze-dried-tuna-cat-treats', brand: 'Goofy Tails · Treat', title: 'Freeze Dried Tuna', category: 'treat', life_stage: 'adult', type: 'cat' },
  { slug: 'goofy-tails-mackerel-and-seaweed-cat-wet-food', brand: 'Goofy Tails · Wet food', title: 'Mackerel and Seaweed', category: 'wet', life_stage: 'adult', type: 'cat' },
  { slug: 'goofy-tails-seafood-bone-broth-for-cats', brand: 'Goofy Tails · Treat', title: 'Seafood Bone Broth for Cats', category: 'treat', life_stage: 'adult', type: 'cat' },
  { slug: 'goofy-tails-tuna-and-anchovies-cat-wet-food-5x70g', brand: 'Goofy Tails · Wet food', title: 'Tuna and Anchovies', category: 'wet', life_stage: 'adult', type: 'cat' },
  { slug: 'goofy-tails-wholesome-all-natural-trial-variety-pack-cat-wet-food', brand: 'Goofy Tails · Wet food', title: 'Wholesome All Natural 3 in 1 Trial Variety Pack', category: 'wet', life_stage: 'adult', type: 'cat', skip: 'variety pack (3-in-1, no single label)' },
];

// ── Exact matching helpers ───────────────────────────────────────────────────
const lc = (s) => String(s || '').toLowerCase();
// normalize spelling variants so matching is robust ("Sea Food" == "Seafood").
const norm = (s) => lc(s).replace(/\bsea\s+food\b/g, 'seafood');
// plural-tolerant whole-word meat test ("anchovies" matches "anchovy")
const meatRe = (m) => new RegExp(`\\b${m}(?:e?s)?\\b`, 'i');
function meatSet(text) {
  const t = lc(text); const s = new Set();
  for (const m of NAMED_MEATS) if (m !== 'fish' && meatRe(m).test(t)) s.add(m);
  if (/\bfish\b/i.test(t)) s.add('fish');
  return s;
}
const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// Drop generic packaging/species/form words; keep the flavour + type descriptors
// that actually identify the recipe (mackerel, seaweed, freeze, dried, bone, broth...).
const STOP = new Set(['and', 'for', 'the', 'with', 'in', 'of', 'a', 'an', 'or', '3', 'in', '1',
  'cat', 'cats', 'kitten', 'kittens', 'food', 'meals', 'meal', 'wet', 'dry',
  'treats', 'treat', 'natural', 'all', 'goofy', 'tails', 'pack', 'g', 'kg',
  'wholesome', 'trial', 'variety', 'chunks', 'flakes']);
function descriptors(title) {
  return (lc(title).match(/[a-z]+/g) || []).filter((w) => w.length > 1 && !STOP.has(w));
}
const VARIETY_RE = /\b(variety|assorted|combo|multi[-\s]?pack|pack of|trio|mixed|trial|kit|bundle|all in one|3\s*in\s*1)\b/i;

// catalog product -> exact match for target, or null.
function matchExact(target, catalog) {
  const want = descriptors(norm(target.title));
  const wantMeat = meatSet(norm(target.title));
  const cands = catalog.filter((p) => {
    const t = norm(p.title);
    if (classifySpecies(p.title) === 'dog') return false;           // never a dog SKU
    if (!target.skip && VARIETY_RE.test(p.title)) return false;     // never a combo/kit for a single SKU
    const tMeat = meatSet(t);
    if (!setEq(tMeat, wantMeat)) return false;                      // identical flavour identity
    return want.every((w) => new RegExp(`\\b${w}(?:e?s)?\\b`, 'i').test(t)); // all descriptors present
  });
  if (!cands.length) return null;
  // most exact = fewest extra descriptor words
  cands.sort((a, b) => descriptors(a.title).length - descriptors(b.title).length);
  return cands[0];
}

// ── OCR + label extraction ───────────────────────────────────────────────────
const SECTION_END = /\b(storage|feeding|direction|directions|nutri\w*|guaranteed|analysis|analytical|serving|net\s*(wt|weight|quantity)|mfg|manufactur\w*|marketed|best\s*before|expiry|use\s*by|keep|caution|warning|fssai|batch|lic|how\s*to|recommend\w*|shake|once\s*opened)\b/i;

async function ocrImages(images, dir) {
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < images.length; i++) {
    try {
      const b = Buffer.from(await (await fetch(images[i].split('?')[0], { headers: UA })).arrayBuffer());
      if (b.length < 9000) continue;            // skip icons/thumbnails
      const f = `${dir}/${i}.img`; writeFileSync(f, b); files.push(f);
    } catch { /* skip unreadable image */ }
  }
  if (!files.length) return '';
  return execFileSync(OCRTOOL, files, { maxBuffer: 256 * 1024 * 1024 }).toString();
}

// Marketing bullets that masquerade as an ingredient list ("Ingredients: No
// Preservatives, Fillers, or Gluten"). A real list names a meat and does not
// open with one of these claim words.
const MARKETING_START = /^(no\b|fresh\b|high\b|human\b|natural\b|premium\b|grain\b|gluten\b|fillers?\b|preservatives?\b|made\b|real\b|quality\b)/i;
const meatFirst = (s) => hasNamedMeat(String(s || '').split(',')[0]);

function cleanList(body) {
  let b = body;
  const end = b.search(SECTION_END);
  if (end > 0) b = b.slice(0, end);
  b = b.split('*')[0].split(/\bdo not\b/i)[0];          // drop footnotes / cautions
  return b.replace(/\s+/g, ' ').trim().replace(/[\s"'.,;:)\]]+$/, '').trim();
}

// Every "Ingredients ..." candidate across all images, cleaned.
function ingredientCandidates(ocr) {
  const out = [];
  for (const chunk of ocr.split('@@@FILE@@@').slice(1)) {
    const text = chunk.slice(chunk.indexOf('\n') + 1).split('@@@END@@@')[0];
    const re = /ingredients?\s*[:\-]?\s*\n?\s*([\s\S]{0,400})/ig;
    let m;
    while ((m = re.exec(text))) { const b = cleanList(m[1]); if (b.length >= 6) out.push(b); }
  }
  return out;
}

// Pick the real comma-separated ingredient list: it must name a meat, not be a
// marketing bullet; prefer meat-first lists, then the one with the most items.
function extractIngredients(ocr) {
  const cands = ingredientCandidates(ocr)
    .filter((b) => (b.match(/,/g) || []).length >= 1)   // >= 2 items
    .filter((b) => hasNamedMeat(b))                      // must contain a named meat
    .filter((b) => !MARKETING_START.test(b));            // not a claims bullet
  if (!cands.length) return { text: null, all: ingredientCandidates(ocr) };
  cands.sort((a, b) => (meatFirst(b) - meatFirst(a)) || ((b.match(/,/g) || []).length - (a.match(/,/g) || []).length));
  return { text: cands[0], all: cands };
}

// Single-ingredient freeze-dried treats declare one meat, not a comma list. Two
// honest evidences, only ever returning the meat the product's OWN title names:
//   (a) an explicit "Ingredients: Tuna" header followed by a single named meat;
//   (b) prose ("made with Whole Shrimps - that's it", "100% organic shrimp").
// Reached only when no multi-ingredient list was found, so there is no list to miss.
const cap = (m) => m.charAt(0).toUpperCase() + m.slice(1);
function extractSingleMeat(ocr, target) {
  const want = meatSet(target.title);
  // (a) explicit single-ingredient declaration
  for (const chunk of ocr.split('@@@FILE@@@').slice(1)) {
    const text = chunk.slice(chunk.indexOf('\n') + 1).split('@@@END@@@')[0];
    const m = text.match(/ingredients?\s*[:\-]?\s*\n?\s*([A-Za-z][A-Za-z ]{1,24})/i);
    if (!m) continue;
    const word = m[1].trim().split(/\s+/).filter((w) => !/^(whole|fresh|dried|freeze|real)$/i.test(w))[0] || '';
    for (const meat of want) if (new RegExp(`^${meat}(?:e?s)?$`, 'i').test(word)) return cap(meat);
  }
  // (b) prose declaration
  const t = ocr.toLowerCase();
  for (const meat of want) {
    const re = new RegExp(`(?:made with\\s+(?:whole\\s+)?|100\\s*%\\s*(?:organic\\s*)?|\\bwhole\\s+)${meat}(?:e?s)?\\b`, 'i');
    if (re.test(t)) return cap(meat);
  }
  return null;
}

// Pull a nutrition block (only useful if it carries explicit % values).
function extractGA(ocr) {
  let best = null;
  for (const chunk of ocr.split('@@@FILE@@@').slice(1)) {
    const text = chunk.slice(chunk.indexOf('\n') + 1).split('@@@END@@@')[0];
    const m = text.match(/(guaranteed analysis|analytical constituents?|nutri\w*[^\n]*)([\s\S]{0,400})/i);
    if (!m) continue;
    const body = (m[1] + ' ' + m[2]).replace(/\s+/g, ' ').trim();
    if (/\d/.test(body) && (!best || body.length > best.length)) best = body;
  }
  return best;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function getCatalog() {
  let all = [];
  for (let pg = 1; pg <= 8; pg++) {
    const r = await fetch(`https://goofytails.com/products.json?limit=250&page=${pg}`, { headers: UA });
    if (!r.ok) break;
    const ps = (await r.json()).products || [];
    if (!ps.length) break;
    all = all.concat(ps);
  }
  return all;
}

const SQLV = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const J = (o) => `$J$${JSON.stringify(o)}$J$::jsonb`;

function toSQL(slug, r, sourceUrl) {
  const a = J(r.analysis);
  return `UPDATE products SET analysis=${a}, analysis_v2=${a}, extracted_facts=${r.extracted_facts ? J(r.extracted_facts) : 'NULL'}, ` +
    `data_completeness='${r.data_completeness}', confidence=${r.confidence}, needs_review=${r.needs_review}, ` +
    `source_url=${SQLV(sourceUrl)}, source_tier='pack-photo', source_fetched_at='${NOW}', rubric_version=${SQLV(r.analysis.rubricVersion)} ` +
    `WHERE slug='${slug}';`;
}

const catalog = await getCatalog();
console.log(`goofytails catalog: ${catalog.length} products\n`);

const sql = [];
for (const target of TARGETS) {
  console.log('━'.repeat(72));
  console.log(`TARGET  ${target.slug}`);
  if (target.skip) { console.log(`  SKIP  ${target.skip}\n`); continue; }

  const match = matchExact(target, catalog);
  if (!match) { console.log(`  NO EXACT MATCH on goofytails.com -> leave "Not verified yet"\n`); continue; }
  const sourceUrl = `https://goofytails.com/products/${match.handle}`;
  console.log(`  MATCH   "${match.title}"`);
  console.log(`          ${sourceUrl}  (${(match.images || []).length} images)`);

  const ocr = await ocrImages((match.images || []).map((i) => i.src), `/tmp/gt/${target.slug}`);
  const ing = extractIngredients(ocr);
  let ingredientsText = ing.text;
  let single = false;
  if (!ingredientsText && target.category === 'treat') {
    const sm = extractSingleMeat(ocr, target);
    if (sm) { ingredientsText = sm; single = true; }
  }
  const gaCand = extractGA(ocr);

  // accept GA only if it yields a real protein % (grams-format labels won't)
  let gaText = null;
  if (gaCand) {
    const probe = parseLabel({ ingredientsText: '', gaText: gaCand });
    if (probe.ga.protein != null) gaText = gaCand;
  }
  console.log(`  INGREDIENTS: ${ingredientsText || '(not found)'}${single ? '  [single-ingredient treat]' : ''}`);
  if (!ingredientsText && ing.all.length) console.log(`  (candidates seen: ${ing.all.slice(0, 4).map((c) => JSON.stringify(c.slice(0, 50))).join(' | ')})`);
  console.log(`  GA: ${gaText ? gaText : `(no parseable % GA${gaCand ? '; grams/format only -> ingredients-first' : ''})`}`);

  const completeness = ingredientsText && gaText ? 'full' : ingredientsText ? 'partial' : 'none';
  const l = {
    slug: target.slug, brand: target.brand, title: target.title, category: target.category,
    life_stage: target.life_stage, type: target.type,
    sourceTier: 'pack-photo', sourceUrl, fetchedAt: NOW, completeness,
    ingredientsText, gaText, identityOk: /goofy/i.test(match.handle), multiProduct: false,
  };
  const r = buildAnalysis(l);
  console.log(`  => verdict: ${r.verdict}  | completeness: ${r.data_completeness} | confidence: ${r.confidence} | needs_review: ${r.needs_review}`);
  if (r.analysis.reviewReason) console.log(`     reviewReason: ${r.analysis.reviewReason}`);
  if (r.firstIngredient) console.log(`     firstIngredient: ${r.firstIngredient}  proteinDM: ${r.proteinDM}  grainFree: ${r.grainFree}`);

  if (r.verdict !== 'Not verified yet') sql.push(toSQL(target.slug, r, sourceUrl));
  console.log('');
}

writeFileSync('/tmp/goofytails.sql', sql.join('\n') + '\n');
console.log('━'.repeat(72));
console.log(`Generated ${sql.length} UPDATE(s) -> /tmp/goofytails.sql (review before applying)`);
