// Shared, brand-agnostic label-harvesting helpers used by the per-brand
// own-site harvesters (harvest_goofytails.mjs, harvest_brand.mjs).
//
// The safety model: we only ever pull a label off a brand's OWN product page,
// and we only attach it to one of our products on an EXACT flavour identity
// (same descriptor set + same named-meat set, same species, not a variety pack).
// Extraction is deterministic; nothing is asserted that the OCR/text did not show.

import { writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { NAMED_MEATS, hasNamedMeat } from './constants.js';
import { classifySpecies } from './identity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const OCRTOOL = resolve(__dirname, '../bin/ocrtool');
export const UA = { 'User-Agent': 'Mozilla/5.0 SniffBot/1.0 (+https://sniff.fyi)' };

export const lc = (s) => String(s || '').toLowerCase();
// normalize spelling variants so matching is robust ("Sea Food" == "Seafood").
export const norm = (s) => lc(s).replace(/\bsea\s+food\b/g, 'seafood').replace(/\boceanfish\b/g, 'ocean fish');

// plural-tolerant whole-word meat test ("anchovies" matches "anchovy")
const meatRe = (m) => new RegExp(`\\b${m}(?:e?s)?\\b`, 'i');
export function meatSet(text) {
  const t = lc(text); const s = new Set();
  for (const m of NAMED_MEATS) if (m !== 'fish' && meatRe(m).test(t)) s.add(m);
  if (/\bfish\b/i.test(t)) s.add('fish');
  return s;
}
const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// Drop generic packaging/species/form words; keep the flavour + type descriptors
// that actually identify the recipe (mackerel, seaweed, freeze, dried, bone, broth...).
const STOP = new Set(['and', 'for', 'the', 'with', 'in', 'of', 'a', 'an', 'or', '3', '1',
  'cat', 'cats', 'kitten', 'kittens', 'food', 'meals', 'meal', 'wet', 'dry',
  'treats', 'treat', 'natural', 'all', 'pack', 'g', 'kg', 'gm', 'ml', 'adult',
  'wholesome', 'trial', 'variety', 'flakes', 'flavour', 'flavor', 'premium',
  'fg', 'limited', 'stocks', 'stock', 'buy', 'get', 'free', 'cat food', 'kitten food',
  // generic recipe-type words that are not flavour/form identity (keep jelly/gravy/
  // mousse/pate/loaf/broth as descriptors so wet textures still discriminate):
  'recipe', 'platter', 'dinner', 'feast', 'entree', 'plate', 'delight', 'delights',
  'meaty', 'tinned', 'canned', 'can', 'pouch', 'pack', 'adult', 'kitten']);
export function descriptors(title) {
  return (lc(title).match(/[a-z]+/g) || []).filter((w) => w.length > 1 && !STOP.has(w));
}
export const VARIETY_RE = /\b(variety|assorted|combo|multi[-\s]?pack|pack of|trio|mixed|trial|kit|bundle|hamper|gift box|all in one|3\s*in\s*1)\b/i;

// catalog product -> exact match for a target, or null.
// brandTokens (optional) restrict candidates to the brand's OWN products on a
// multi-brand site (e.g. headsupfortails.com sells many brands).
export function matchExact(target, catalog, brandTokens = []) {
  const want = descriptors(norm(target.title));
  const wantMeat = meatSet(norm(target.title));
  if (!want.length) return null; // nothing distinctive to match on -> refuse
  const cands = catalog.filter((p) => {
    const t = norm(p.title);
    if (brandTokens.length && !brandTokens.some((b) => new RegExp(`\\b${b}`, 'i').test(`${p.title} ${p.vendor || ''} ${p.handle || ''}`))) return false;
    if (classifySpecies(p.title) === 'dog') return false;          // never a dog SKU
    if (!target.skip && VARIETY_RE.test(p.title)) return false;    // never a combo/kit for a single SKU
    if (!setEq(meatSet(t), wantMeat)) return false;               // identical flavour identity
    return want.every((w) => new RegExp(`\\b${w}(?:e?s)?\\b`, 'i').test(t)); // all descriptors present
  });
  if (!cands.length) return null;
  cands.sort((a, b) => descriptors(norm(a.title)).length - descriptors(norm(b.title)).length);
  return cands[0];
}

// ── OCR + label extraction ───────────────────────────────────────────────────
const SECTION_END = /\b(storage|feeding|direction|directions|nutri\w*|guaranteed|analysis|analytical|serving|net\s*(wt|weight|quantity)|mfg|manufactur\w*|marketed|best\s*before|expiry|use\s*by|keep|caution|warning|fssai|batch|lic|how\s*to|recommend\w*|shake|once\s*opened)\b/i;
const MARKETING_START = /^(no\b|fresh\b|high\b|human\b|natural\b|premium\b|grain\b|gluten\b|fillers?\b|preservatives?\b|made\b|real\b|quality\b)/i;
const meatFirst = (s) => hasNamedMeat(String(s || '').split(',')[0]);
export const cap = (m) => m.charAt(0).toUpperCase() + m.slice(1);

function cleanList(body) {
  let b = body;
  const end = b.search(SECTION_END);
  if (end > 0) b = b.slice(0, end);
  b = b.split('*')[0].split(/\bdo not\b/i)[0]
       .split(/\bno added\b|\bno artificial\b|\bno synthetic\b|\bno preservativ/i)[0]; // drop claim tails
  return b.replace(/\s+/g, ' ').trim().replace(/[\s"'.,;:)\]]+$/, '').trim();
}

// A real ingredient list LEADS with a real ingredient: a short noun (1-3 words),
// no digits, not a marketing phrase ("Just Dehydrated Human Grade", "High Quality
// Protein Ingredients"). This is the guard against OCR grabbing a banner as the
// "first ingredient" on marketing-heavy packs. Abstain rather than publish junk.
const LEAD_MARKETING = /\b(quality|grade|ingredients?|single|human|flavou?rs?|preservativ\w*|natural|premium|high|just|made|recipe|supports?|packed|crispy|crunch\w*|snack\w*|superior|nutrition|balanced|complete|wholesome|protein[-\s]packed)\b/i;
function cleanLead(item) {
  const w = String(item || '').trim();
  if (w.length < 3 || w.length > 40) return false;     // a real lead is a short noun phrase
  if (/\d/.test(w)) return false;                       // no "60g protein" banners
  if (w.split(/\s+/).length > 5) return false;          // "Water sufficient for processing" ok; marketing run-ons not
  if (LEAD_MARKETING.test(w)) return false;             // reject claim-words ("Just Dehydrated Human Grade")
  return true;
}

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

// Pick the real comma-separated ingredient list: must name a meat, not be a
// marketing bullet; prefer meat-first lists, then the one with the most items.
// OCR often jams marketing words between the "Ingredients" header and the real
// list ("...reamy Tuna Flavour Chicken  Chicken Meat, Tuna, ..."). If the first
// comma-item isn't a clean lead but DOES contain a named meat, trim everything
// before that meat so the real list ("Chicken Meat, Tuna, ...") is recovered.
const MEAT_RE_G = new RegExp(`\\b(?:${NAMED_MEATS.join('|')})(?:e?s|ies)?\\b`, 'ig');
function trimToLastMeat(item) {
  let last = -1, m; MEAT_RE_G.lastIndex = 0;
  while ((m = MEAT_RE_G.exec(item))) last = m.index;
  return last <= 0 ? item : item.slice(last).trim();
}

export function extractIngredients(ocr) {
  const raw = ingredientCandidates(ocr);
  const norm = raw.map((b) => {
    const parts = b.split(',');
    if (!cleanLead(parts[0])) { const t = trimToLastMeat(parts[0]); if (cleanLead(t)) { parts[0] = t; return parts.join(','); } }
    return b;
  });
  const cands = norm
    .filter((b) => (b.match(/,/g) || []).length >= 1)
    .filter((b) => hasNamedMeat(b))
    .filter((b) => !MARKETING_START.test(b))
    .filter((b) => cleanLead(b.split(',')[0]));   // lead must look like a real ingredient
  if (!cands.length) return { text: null, all: raw };
  cands.sort((a, b) => (meatFirst(b) - meatFirst(a)) || ((b.match(/,/g) || []).length - (a.match(/,/g) || []).length));
  return { text: cands[0], all: cands };
}

// Single-ingredient declaration ("Ingredients: Tuna", "made with Whole Shrimps").
// Only ever returns the meat the product's OWN title names.
export function extractSingleMeat(ocr, target) {
  const want = meatSet(target.title);
  const t = lc(ocr);
  // (a) explicit "Ingredients: <meat>"
  for (const chunk of ocr.split('@@@FILE@@@').slice(1)) {
    const text = chunk.slice(chunk.indexOf('\n') + 1).split('@@@END@@@')[0];
    const m = text.match(/ingredients?\s*[:\-]?\s*\n?\s*([A-Za-z][A-Za-z ]{1,24})/i);
    if (!m) continue;
    const word = m[1].trim().split(/\s+/).filter((w) => !/^(whole|fresh|dried|freeze|real)$/i.test(w))[0] || '';
    for (const meat of want) if (new RegExp(`^${meat}(?:e?s)?$`, 'i').test(word)) return cap(meat);
  }
  // (b) prose ("made with Whole Shrimps", "100% organic shrimp")
  for (const meat of want) {
    const re = new RegExp(`(?:made with\\s+(?:whole\\s+)?|100\\s*%\\s*(?:organic\\s*)?|\\bwhole\\s+)${meat}(?:e?s)?\\b`, 'i');
    if (re.test(t)) return cap(meat);
  }
  // (c) the pack explicitly says single-ingredient AND names the title's meat
  if (/\bsingle[\s-]?ingredient\b/i.test(t)) {
    for (const meat of want) if (new RegExp(`\\b${meat}(?:e?s)?\\b`, 'i').test(t)) return cap(meat);
  }
  return null;
}

// Pull a nutrition block (only useful if it carries explicit % values).
export function extractGA(ocr) {
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

export async function ocrImages(images, dir) {
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < images.length; i++) {
    try {
      const b = Buffer.from(await (await fetch(images[i].split('?')[0], { headers: UA })).arrayBuffer());
      if (b.length < 9000) continue;
      const f = `${dir}/${i}.img`; writeFileSync(f, b); files.push(f);
    } catch { /* skip unreadable image */ }
  }
  if (!files.length) return '';
  return execFileSync(OCRTOOL, files, { maxBuffer: 256 * 1024 * 1024 }).toString();
}

// Fetch a Shopify catalog (all pages).
export async function fetchShopifyCatalog(domain) {
  let all = [];
  for (let pg = 1; pg <= 12; pg++) {
    let r;
    try { r = await fetch(`https://${domain}/products.json?limit=250&page=${pg}`, { headers: UA }); }
    catch { break; }
    if (!r.ok) break;
    const ps = (await r.json()).products || [];
    if (!ps.length) break;
    all = all.concat(ps);
  }
  return all;
}
