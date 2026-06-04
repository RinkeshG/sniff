// Fetch a REAL label for a product. Only authoritative, labeled sections count
// as a source: the Composition/Ingredients block and the Analytical Constituents/
// Guaranteed Analysis block. Marketing prose, mismatched pages, multi-product
// pages, and truncated lists are rejected (each forces a "not disclosed").
//
// Tier 2 (Supertails Shopify .json) is implemented here. Tier 1 (brand official
// site) is a hook that currently abstains rather than guess, by design.

import { listLooksComplete } from './compute.js';

function htmlToText(html) {
  return String(html || '')
    // Flatten each <li>...</li> (often <li><p><span>text</span></p></li>) to one bullet line.
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => '\n• ' + inner.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim())
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
  const m = line.match(new RegExp(`^(${words})\\b\\s*(:?)\\s*(.*)$`, 'i'));
  if (!m) return null;
  if (m[2] === ':') return { content: m[3].trim() };      // "Composition: ..."
  if (m[3].trim() === '') return { content: '' };          // bare "Ingredients"
  return null;                                             // "Ingredients like chicken..." -> not a header
}
const ING_WORDS = 'composition|ingredients?';
const GA_WORDS = 'analytical (?:constituents?|compounds?|composition)|guaranteed analysis|nutritional (?:information|analysis|composition)|composition analysis';
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

function findIngredients(lines) {
  const i = lines.findIndex(isIngHeader);
  if (i < 0) return null;
  const h = headerMatch(lines[i], ING_WORDS);
  if (h.content && topCommas(h.content) >= 2) return stripLabel(h.content);

  const bullets = [];
  for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
    const raw = lines[j].trim();
    if (!raw) { if (bullets.length) break; else continue; }
    const isBullet = raw.startsWith('•');
    const body = (isBullet ? raw.replace(/^•\s*/, '') : raw).trim();
    if (topCommas(body) >= 2) return stripLabel(body);   // full list on one line or one bullet
    if (isBullet) { bullets.push(body); continue; }       // multi-item bullet list
    if (bullets.length) break;
    if (/^[A-Za-z][\w\s/&]{2,32}:?$/.test(raw)) break;    // next header
    break;
  }
  return bullets.length >= 3 ? bullets.join(', ') : null;
}

// Real guaranteed analysis only: a labeled GA block, or a line that lists a
// protein percentage plus another nutrient percentage. Never the ingredient line.
function findGA(lines, ingredientsText) {
  const i = lines.findIndex((l) => headerMatch(l, GA_WORDS));
  if (i >= 0) {
    const h = headerMatch(lines[i], GA_WORDS);
    if (/\d/.test(h.content) && /(%|mg\/kg|g\/kg)/i.test(h.content)) return h.content;
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const l = lines[j].trim();
      if (!l) continue;
      if (/\d/.test(l) && /(%|mg\/kg|g\/kg)/i.test(l)) return l;
      break;
    }
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
  const ingT = findIngredients(lines);
  const gaT = findGA(lines, ingT);
  const ingredientsText = (ingT && /,/.test(ingT) && listLooksComplete(ingT) && identityOk && !multiProduct) ? ingT : null;
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
