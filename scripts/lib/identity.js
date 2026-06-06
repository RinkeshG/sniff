// Identity model: "what product is this, and what does this label describe?"
//
// The pipeline already proves a label's values are verbatim-real (validate.js).
// This module proves the label is the RIGHT one for the product and that the
// result is internally consistent. It is the structural answer to the wrong-but-
// real-label class of bug (a dry SKU wearing a wet pouch's label, a cat product
// wearing a dog label, a salmon product wearing a tuna label).
//
// Everything here is pure, deterministic, and conservative: it only declares a
// conflict on KNOWN-vs-KNOWN disagreement, so an unknown field never causes a
// false abstain. Hard conflicts (form/species/brand/life-stage) mean the label
// cannot belong to the product -> abstain. Soft conflicts (flavour) mean "looks
// off, a human should glance" -> needs_review, never a silent wrong card.

import { NAMED_MEATS, isGenericProtein } from './constants.js';

const lc = (s) => String(s || '').toLowerCase();
const wordRe = (w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');

// ── Form: wet | dry | treat | unknown ───────────────────────────────────────
// A treat is a treat regardless of moisture (creamy/jerky/lickable), so it is
// checked first. Otherwise moisture is the strongest signal (wet >= 45%, dry
// <= 16%); keywords fill the gap. 16-45% (semi-moist) stays unknown on purpose.
const TREAT_RE = /\b(treat|treats|churu|creamy|cream|temptation|temptations|dreamies|stick|sticks|jerky|biscuit|biscuits|crunch|crunchies|crunchy|lickable|chew|chews|catnip|topper|nibbles|bites|filet bites|cubes)\b/i;
const WET_RE = /\b(gravy|jelly|pouch|pouches|canned|\bcan\b|tinned|\btin\b|wet|mousse|broth|loaf|pate|p[aâ]t[eé]|chunks|fillet|terrine|soup|stew|sauce|in[-\s]jelly|in[-\s]gravy)\b/i;
const DRY_RE = /\b(dry|kibble|croquette)\b/i;

export function classifyForm(text, moisture) {
  const t = lc(text);
  if (TREAT_RE.test(t)) return 'treat';
  if (moisture != null && Number.isFinite(moisture)) {
    if (moisture >= 45) return 'wet';
    if (moisture <= 16) return 'dry';
  }
  if (WET_RE.test(t)) return 'wet';
  if (DRY_RE.test(t)) return 'dry';
  return 'unknown';
}

// ── Species: cat | dog | unknown ────────────────────────────────────────────
const DOG_RE = /\b(dog|dogs|puppy|puppies|canine)\b/i;
const CAT_RE = /\b(cat|cats|kitten|kittens|feline)\b/i;
export function classifySpecies(text) {
  const t = lc(text);
  const dog = DOG_RE.test(t), cat = CAT_RE.test(t);
  if (dog && !cat) return 'dog';
  if (cat && !dog) return 'cat';
  return 'unknown';
}

// ── Life-stage: kitten | adult | senior | all | unknown ─────────────────────
export function classifyLifeStage(text) {
  const t = lc(text);
  if (/\ball life ?stages?\b/.test(t)) return 'all';
  // a label that addresses both kitten and adult is "all"
  if (/\bkitten\b/.test(t) && /\badult\b/.test(t)) return 'all';
  // "...for Cats and Kittens" / "Cat Food and Kitten Food" addresses the whole
  // range, so it is all-life-stages, not kitten-specific (which would falsely
  // conflict with an adult product). Proximity-bound so it stays precise.
  if (/\bcats?\b.{0,15}\bkittens?\b|\bkittens?\b.{0,15}\bcats?\b/is.test(t)) return 'all';
  if (/\b(kitten|kittens|junior|mother (?:and|&) baby|growth|starter)\b/.test(t)) return 'kitten';
  if (/\b(senior|mature|ageing|aging|7\s*\+|11\s*\+)\b/.test(t)) return 'senior';
  if (/\b(adult|1\s*\+)\b/.test(t)) return 'adult';
  return 'unknown';
}

// ── Brand: normalize display/handle to a canonical manufacturer key ─────────
// Aliases collapse a manufacturer's sub-brands/product-lines so a correct row
// (e.g. an "advance-veterinary-diets" handle on an "Affinity Petcare" product)
// is NOT flagged. Built from the false positives the live audit surfaced.
const BRAND_ALIASES = {
  affinity: 'affinity', advance: 'affinity', libra: 'affinity', ultima: 'affinity',
  purina: 'purina', felix: 'purina', friskies: 'purina', proplan: 'purina', supercoat: 'purina',
  farmina: 'farmina', matisse: 'farmina', nd: 'farmina',
  versele: 'versele-laga', laga: 'versele-laga', lara: 'versele-laga', classic: 'versele-laga',
  huft: 'huft', heads: 'huft', headsupfortails: 'huft',
  inaba: 'inaba', churu: 'inaba',
  royal: 'royal-canin', canin: 'royal-canin',
};
// Recognized brand tokens (first token of every brand seen in the catalog).
// A token is a "known brand" if it is here or in BRAND_ALIASES; only then can it
// participate in a brand conflict, so generic handle words never trip it.
const KNOWN_BRANDS = new Set([
  'me', 'sheba', 'signature', 'whiskas', 'drools', 'purrfeto', 'temptations', 'active',
  'carniwel', 'kittos', 'petstar', 'moochie', 'smylo', 'bellotta', 'schesir', 'goofy',
  'calibra', 'jinny', 'purepet', 'catit', 'avant', 'kennel', 'hachi', 'bark', 'cataholic',
  'indiecat', 'trixie', 'purrkins', 'novee', 'himalaya', 'orijen', 'furloved', 'basil',
  'datgud', 'vivaldis', 'nutrience', 'acana', 'applaws', 'schesir', 'maxi',
  // NOTE: 'kitty' is deliberately NOT a brand key: "Kitty Licks", "Kitty Treats"
  // and "Kitty Yums" are different brands and must never cross-match on it.
  // canonical keys (so a normalized key still reads as known on the other side)
  'affinity', 'purina', 'farmina', 'versele-laga', 'huft', 'inaba', 'royal-canin',
]);

export function brandKey(str) {
  const head = lc(str).split('·')[0];
  const tokens = head.match(/[a-z0-9]+/g) || [];
  for (const tk of tokens) {
    if (BRAND_ALIASES[tk]) return BRAND_ALIASES[tk];
    if (KNOWN_BRANDS.has(tk)) return tk;
  }
  return ''; // unknown brand -> never conflicts
}

// ── Flavour: the named meat a product/label claims ──────────────────────────
const flavourSet = (text) => {
  const t = lc(text);
  const out = new Set();
  for (const m of NAMED_MEATS) if (wordRe(m).test(t)) out.add(m);
  return out;
};
export const titleFlavours = (title) => flavourSet(title);

// The named meat the label actually LEADS with (its first substantive
// ingredient). Generic leads ("meat and animal derivatives") are not a named
// claim, so they return null and never trigger a flavour conflict.
export function leadMeat(firstIngredient) {
  const head = String(firstIngredient || '').split('(')[0].trim();
  if (!head || isGenericProtein(head)) return null;
  for (const m of NAMED_MEATS) if (wordRe(m).test(head)) return m;
  return null;
}

// ── Identities ──────────────────────────────────────────────────────────────
// product meta: { brand, title, category, type, life_stage, slug }
export function productIdentity(meta = {}) {
  const cat = lc(meta.category);
  const formText = `${meta.category || ''} ${meta.title || ''} ${meta.brand || ''}`;
  const lifeKnown = ['kitten', 'adult', 'senior', 'all'].includes(lc(meta.life_stage));
  return {
    brandKey: brandKey(meta.brand),
    species: meta.type ? lc(meta.type) : classifySpecies(`${meta.title} ${meta.category}`),
    form: ['wet', 'dry', 'treat'].includes(cat) ? cat : classifyForm(formText, null),
    lifeStage: lifeKnown ? lc(meta.life_stage) : classifyLifeStage(meta.title),
    flavours: titleFlavours(meta.title),
  };
}

// label input: { facts, sourceUrl, vendor, handle, firstIngredient }
// `facts` is validate.js output (facts.ga.moisture, facts.ingredientsText).
// IMPORTANT: the label's identity must come from the LABEL's own evidence
// (its moisture, the retailer's product handle, its vendor) and NEVER from the
// product's title. Mixing the product title in would be circular (it would echo
// the product, hiding real mismatches) and trips on stray title words like
// "dry bonito flake" on a wet food.
export function labelIdentity(input = {}) {
  const facts = input.facts || {};
  const moisture = facts.ga ? facts.ga.moisture : null;
  const handle = input.handle ||
    String(input.sourceUrl || '').replace(/^https?:\/\/[^/]+\/products\//, '').replace(/\.json.*$/, '');
  // a Shopify CDN image path is not a product handle; it carries no identity.
  const handleForm = /cdn\.shopify\.com|\/files\//.test(input.sourceUrl || '') ? '' : handle;
  const firstIng = input.firstIngredient ||
    (facts.ingredients && facts.ingredients[0] && facts.ingredients[0].name) || '';
  return {
    brandKey: brandKey(`${input.vendor || ''} ${handleForm}`),
    species: classifySpecies(`${handleForm} ${input.vendor || ''}`),
    form: classifyForm(`${handleForm} ${input.vendor || ''}`, moisture),
    lifeStage: classifyLifeStage(handleForm),
    flavours: titleFlavours(handleForm),
    leadMeat: leadMeat(firstIng),
  };
}

// ── Conflict detection (the gate) ───────────────────────────────────────────
const bothKnown = (a, b, unknown = 'unknown') => a && b && a !== unknown && b !== unknown;

// form conflict only on a wet<->dry disagreement (treats vary in moisture).
function formConflict(a, b) {
  const wd = (f) => (f === 'wet' || f === 'dry') ? f : null;
  const x = wd(a), y = wd(b);
  return !!(x && y && x !== y);
}
export function lifeStageConflict(a, b) {
  if (a === 'all' || b === 'all') return false;
  return bothKnown(a, b) && a !== b;
}

// A flavour conflict = the label LEADS with a named meat the title never names,
// and none of the title's named meats appear in the ingredient list. That is the
// cross-variant signature (salmon product, tuna leads). A cereal/by-product lead
// (leadMeat null) or a "flavoured but generic" food does NOT conflict.
const SPECIFIC_FISH = new Set(['salmon', 'tuna', 'mackerel', 'sardine', 'herring', 'trout', 'cod', 'pollock', 'pollack', 'snapper', 'whitefish', 'anchovy', 'bonito', 'tilapia', 'catfish', 'seabream']);
const isFish = (m) => m === 'fish' || SPECIFIC_FISH.has(m);
function flavourConflict(prod, label, ingredientsText) {
  const lead = label.leadMeat;
  if (!lead) return false;
  if (!prod.flavours || prod.flavours.size === 0) return false;
  if (prod.flavours.has(lead)) return false;
  // "Ocean fish" / generic "fish" is satisfied by ANY fish lead (a sardine IS an
  // ocean fish). Only flag when the title names a SPECIFIC species that differs.
  const titleSpecificFish = [...prod.flavours].some((f) => SPECIFIC_FISH.has(f));
  if (prod.flavours.has('fish') && !titleSpecificFish && isFish(lead)) return false;
  const ing = lc(ingredientsText);
  for (const f of prod.flavours) if (ing.includes(f)) return false;
  return true;
}

// Internal-consistency checks (independent of which product the label is for):
//  - a guaranteed analysis whose components exceed 100% was mis-parsed.
//  - completeness is DERIVED, not trusted: a wet food with no moisture cannot be
//    "full" because dry-matter protein/carbs can't be computed without it.
export function consistencyFlags({ facts, prodForm, harvesterCompleteness } = {}) {
  const ga = (facts && facts.ga) || {};
  const gaSum = ['protein', 'fat', 'fibre', 'moisture', 'ash'].reduce((s, k) => s + (ga[k] != null ? ga[k] : 0), 0);
  const gaImplausible = gaSum > 103;
  let full = harvesterCompleteness === 'full';
  if (prodForm === 'wet' && ga.moisture == null) full = false;
  return { gaImplausible, gaSum, completeness: full ? 'full' : 'partial' };
}

// HARD (abstain): form (moisture/handle driven) and species are physical/
// categorical facts of the label that cannot be naming noise; every real
// contamination is caught here. SOFT (needs_review): brand, life-stage, flavour
// are flagged for a human glance, never silently abstained, because real product
// metadata is messy (a wrong life_stage field, a sub-brand name, a generic
// flavour word) and hard-abstaining on them throws away correct rows.
export function identityConflict(prod, label, ingredientsText = '') {
  const hard = [];
  const soft = [];
  if (formConflict(prod.form, label.form))
    hard.push(`form: product is ${prod.form}, label is ${label.form}`);
  if (bothKnown(prod.species, label.species) && prod.species !== label.species)
    hard.push(`species: product is ${prod.species}, label is ${label.species}`);
  if (bothKnown(prod.brandKey, label.brandKey, '') && prod.brandKey !== label.brandKey)
    soft.push(`brand: product is ${prod.brandKey}, label is ${label.brandKey}`);
  if (lifeStageConflict(prod.lifeStage, label.lifeStage))
    soft.push(`life-stage: product is ${prod.lifeStage}, label is ${label.lifeStage}`);
  if (flavourConflict(prod, label, ingredientsText))
    soft.push(`flavour: label leads with ${label.leadMeat}, which the title does not name`);
  return { hard, soft, ok: hard.length === 0 };
}
