// Fetch a REAL label for a product. Only authoritative, labeled sections count
// as a source: the Composition/Ingredients block and the Analytical Constituents/
// Guaranteed Analysis block. Marketing prose, mismatched pages, multi-product
// pages, and truncated lists are rejected (each forces a "not disclosed").
//
// Tier 2 (Supertails Shopify .json) is implemented here. Tier 1 (brand official
// site) is a hook that currently abstains rather than guess, by design.

import { listLooksComplete } from './compute.js';
import { hasNamedMeat } from './constants.js';

// Inline tags can sit MID-WORD (e.g. "L<span>amb"), so they must be removed with
// no space or the word splits ("L amb"). Block tags become whitespace boundaries.
const INLINE_TAGS = /<\/?(?:span|b|strong|em|i|u|a|font|mark|small|sub|sup|wbr|abbr|cite|q|label|time|bdi|bdo)\b[^>]*>/gi;
function htmlToText(html) {
  return String(html || '')
    .replace(INLINE_TAGS, '')                // drop inline tags first (rejoin split words)
    // Flatten each <li>...</li> (often <li><p><span>text</span></p></li>) to one bullet line.
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => '\n• ' + inner.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim())
    // Flatten each table ROW to one line so a "Nutrient | value" GA table reads as
    // "Crude Protein 30%" instead of the name and value landing on separate lines.
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_m, inner) => '\n' + inner.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim())
    .replace(/<\/(ul|ol)>/gi, '\n\n')        // the list block ends with a hard break
    .replace(/<\s*(br|\/p|\/div|\/h\d|\/tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&rsquo;|&apos;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// A header is a LABEL: either "Label:" (optionally with content after) or the
// bare word alone on its own line. NOT the word buried in a marketing sentence.
function headerMatch(line, words) {
  const m = line.match(new RegExp(`^(${words})\\b\\s*(.*)$`, 'i'));
  if (!m) return null;
  const rest = m[2].trim();
  if (rest === '') return { content: '' };                       // bare "Ingredients"
  if (rest[0] === ':') return { content: rest.slice(1).trim() }; // "Composition: ..."
  // A short keyword-led phrase ending in a colon is still a header
  // ("Nutritional info of each pack:", "Each pack contains:"), but a sentence
  // ("Ingredients like chicken make this great.") is not.
  if (/:$/.test(rest) && rest.length <= 32 && !/[.!?]/.test(rest)) return { content: '' };
  return null;                                                   // keyword buried in prose
}
const ING_WORDS = 'composition|ingredients?|each pack contains|pack contains';
const GA_WORDS = 'analytical (?:constituents?|compounds?|composition)|guaranteed analysis|nutritional (?:info|information|analysis|composition)|nutrition (?:info|information|analysis|facts)|composition analysis';
const isIngHeader = (l) => !!headerMatch(l, ING_WORDS);
// A real GA mention: a nutrient immediately followed by a percentage.
const GA_PROTEIN = /\bprotein\b\s*[:=]?\s*\d{1,2}(?:\.\d+)?\s*%/i;
const GA_SUPPORT = /\b(fat|oils?|moisture|fibre|fiber|ash)\b\s*[:=]?\s*\d{1,2}(?:\.\d+)?\s*%/i;

// Gather the ingredient list after the header: inline comma list, next comma
// line, or a run of bullet items (joined with commas).
const stripLabel = (s) => s.replace(/^(composition|ingredients?)\s*:\s*/i, '').trim();

// Count TOP-LEVEL item separators (commas OR semicolons), ignoring those inside
// parentheses like "Minerals (Ca, P)". A real list has 2+.
function topCommas(s) {
  let d = 0, n = 0;
  for (const ch of s) {
    if (ch === '(' || ch === '[') d++;
    else if (ch === ')' || ch === ']') d = Math.max(0, d - 1);
    else if ((ch === ',' || ch === ';') && d === 0) n++;
  }
  return n;
}

// A lone, clearly-named ingredient IS a complete list (single-ingredient treats:
// "Ingredients: Anchovies"). Accept it; reject marketing tokens up the chain.
function isSingleIngredient(s) {
  const v = String(s || '').replace(/\(.*?\)/g, '').trim();
  return !!v && topCommas(v) === 0 && v.split(/\s+/).length <= 3 && hasNamedMeat(v);
}

// A real list LEADS with a real ingredient, not a marketing sentence. Guards the
// text extractor against "Ingredients: Blended with nutrient-rich superfoods..."
// (the lead must be a short noun, no claim words). Mirrors labelharvest.cleanLead.
const LEAD_MARKETING = /\b(quality|grade|single|human|flavou?rs?|preservativ\w*|natural|premium|high|just|made|recipe|supports?|packed|crispy|crunch\w*|snack\w*|superior|nutrition|balanced|complete|wholesome|blended|crafted|delicious|tasty|benefits?|healthy|rich|nutrient|added|formulated|goodness|taste|cravings?|wellness)\b/i;
function cleanLead(item) {
  const w = String(item || '').replace(/\(.*?\)/g, '').trim();
  if (w.length < 3 || w.length > 40) return false;
  if (/\d/.test(w)) return false;
  if (w.split(/\s+/).length > 5) return false;
  if (LEAD_MARKETING.test(w)) return false;
  return true;
}

function findIngredients(lines) {
  const i = lines.findIndex(isIngHeader);
  if (i < 0) return null;
  const h = headerMatch(lines[i], ING_WORDS);
  if (h.content && topCommas(h.content) >= 2 && cleanLead(h.content.split(',')[0])) return stripLabel(h.content);
  if (h.content && isSingleIngredient(stripLabel(h.content))) return stripLabel(h.content).replace(/[.;]+$/, '').trim();

  const bullets = [];
  for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
    const raw = lines[j].trim();
    if (!raw) { if (bullets.length) break; else continue; }
    const isBullet = raw.startsWith('•');
    const body = (isBullet ? raw.replace(/^•\s*/, '') : raw).trim();
    if (topCommas(body) >= 2 && cleanLead(body.split(',')[0])) return stripLabel(body);   // full list on one line or one bullet
    if (!bullets.length && isSingleIngredient(body)) return body.replace(/[.;]+$/, '').trim();
    if (isBullet) { bullets.push(body); continue; }       // multi-item bullet list
    if (bullets.length) break;
    if (/^[A-Za-z][\w\s/&]{2,32}:?$/.test(raw)) break;    // next header
    break;
  }
  return bullets.length >= 3 ? bullets.join(', ') : null;
}

// Context-aware fallback for run-on descriptions where the list is NOT on its own
// line ("...Key Features: ... Ingredients : Anchovies Serving Recommendation:...").
// Only fires on an explicit "Ingredients:" / "Composition:" label (a colon-led
// declaration, never a stray marketing mention), and stops at the next section.
const NEXT_SECTION = /\b(serving|feeding|storage|nutrition\w*|guaranteed|analytical|analysis|net\s|best before|direction|recommend|how to|caution|manufactur|marketed|fssai)\b/i;
function findIngredientsInline(text) {
  const re = /\b(?:composition|ingredients?)\s*[:\-]\s*([A-Za-z(][\s\S]{0,400})/ig;
  let m;
  while ((m = re.exec(text))) {
    let body = m[1];
    const s = body.search(NEXT_SECTION);
    if (s > 0) body = body.slice(0, s);
    body = body.replace(/\s+/g, ' ').trim().replace(/[.;,]+$/, '');
    const lead = cleanLead(body.split(',')[0]);
    if (topCommas(body) >= 2 && listLooksComplete(body) && lead) return body;
    if (topCommas(body) >= 1 && hasNamedMeat(body) && lead) return body;  // short 2-item list
    if (isSingleIngredient(body)) return body;                            // single-ingredient
    // else: a marketing "Ingredients:" mention -> keep scanning for a real one
  }
  return null;
}

// Real guaranteed analysis only: a labeled GA block, or a line that lists a
// protein percentage plus another nutrient percentage. Never the ingredient line.
const HAS_VALUE = /\d/;
const HAS_UNIT = /(%|mg\/kg|g\/kg)/i;
function findGA(lines, ingredientsText) {
  const i = lines.findIndex((l) => headerMatch(l, GA_WORDS));
  if (i >= 0) {
    const h = headerMatch(lines[i], GA_WORDS);
    if (HAS_VALUE.test(h.content) && HAS_UNIT.test(h.content)) return h.content; // full GA on the header line
    // Otherwise collect the run of value lines below the header. A GA table flattens
    // to one "Nutrient value" line per row ("Crude Protein 30%", "Crude Fat 9%", ...),
    // so gather consecutive lines carrying a percentage / mg-kg and join them.
    const collected = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 25); j++) {
      const l = lines[j].trim();
      if (!l) { if (collected.length) break; else continue; }
      if (HAS_VALUE.test(l) && HAS_UNIT.test(l)) { collected.push(l); continue; }
      break; // first non-value line ends the GA block
    }
    if (collected.length) return collected.join('; ');
  }
  const inline = lines.find((l) => l !== ingredientsText && GA_PROTEIN.test(l) && GA_SUPPORT.test(l));
  return inline ? inline.trim() : null;
}

function tokens(s) {
  return new Set(String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
}

// The product's brand should show up on the page we fetched. Backstop against
// attaching a real label to the wrong product.
function identityOk(product, pageTitle, vendor) {
  const brand = String(product.brand || '').toLowerCase().replace(/·.*$/, '').trim();
  if (!brand) return true;
  const brandTok = [...tokens(brand)];
  const pageTok = tokens(`${pageTitle} ${vendor}`);
  if (!brandTok.length) return true;
  return brandTok.some((t) => pageTok.has(t));
}

function handleFromLink(link, slug) {
  const m = String(link || '').match(/\/products\/([^/?#]+)/);
  return (m && m[1]) || slug || null;
}

// Extract {ingredientsText, gaText, completeness, multiProduct} from any Shopify
// body_html (Supertails or another retailer). identityOk is decided by the
// caller (it knows how the product was matched).
export function extractLabelFromHtml(bodyHtml, identityOk = true) {
  const text = htmlToText(bodyHtml);
  const lines = text.split('\n').map((l) => l.trim());
  const multiProduct = lines.filter(isIngHeader).length >= 2;
  let ingT = findIngredients(lines);
  if (!ingT) ingT = findIngredientsInline(text);   // run-on description fallback
  const gaT = findGA(lines, ingT);
  // Accept a multi-item list (>=1 comma; the finders already require a clean,
  // named-meat lead) OR a single named-meat ingredient. Completeness is not
  // re-gated here: compute() conservatively returns grain-free=unknown for a
  // truncated list, so a real-but-trimmed list is still safe to use (partial).
  const single = !!ingT && isSingleIngredient(ingT);
  const listOk = !!ingT && /,/.test(ingT);
  const ingredientsText = (ingT && (listOk || single) && identityOk && !multiProduct) ? ingT : null;
  const gaText = (gaT && /\d/.test(gaT) && identityOk) ? gaT : null;
  const have = !!ingredientsText || !!gaText;
  return { ingredientsText, gaText, multiProduct, completeness: ingredientsText && gaText ? 'full' : have ? 'partial' : 'none' };
}

// Returns the structured label source, or a 'none' result that triggers abstain.
export async function fetchSupertailsLabel(product, { fetch: f = fetch } = {}) {
  const handle = handleFromLink(product.product_link, product.slug);
  const base = { ingredientsText: null, gaText: null, sourceUrl: null, sourceTier: 'supertails', fetchedAt: new Date().toISOString(), identityOk: false, multiProduct: false, completeness: 'none' };
  if (!handle) return base;
  const url = `https://supertails.com/products/${handle}.json`;
  base.sourceUrl = url;

  let json;
  try {
    const r = await f(url, { headers: { 'User-Agent': 'SniffBot/1.0 (+https://sniff.fyi)' } });
    if (!r.ok) return base;
    json = await r.json();
  } catch { return base; }

  const p = json && json.product;
  if (!p) return base;

  base.identityOk = identityOk(product, p.title, p.vendor);
  const ex = extractLabelFromHtml(p.body_html, base.identityOk);
  base.multiProduct = ex.multiProduct;
  base.ingredientsText = ex.ingredientsText;
  base.gaText = ex.gaText;
  base.completeness = ex.completeness;
  return base;
}

// Tier 1 placeholder. Until a vetted brand-source adapter exists, we abstain
// rather than scrape "randomly anything" and risk another bad-data loop.
export async function fetchBrandLabel(/* product */) {
  return { ingredientsText: null, gaText: null, sourceUrl: null, sourceTier: 'brand', fetchedAt: new Date().toISOString(), identityOk: false, multiProduct: false, completeness: 'none' };
}

// Try authoritative sources in order; return the first that yields a real label.
export async function fetchLabel(product, opts = {}) {
  const st = await fetchSupertailsLabel(product, opts);
  if (st.completeness !== 'none') return st;
  const brand = await fetchBrandLabel(product, opts);
  if (brand.completeness !== 'none') return brand;
  return st; // carries sourceUrl + why-empty for logging
}
