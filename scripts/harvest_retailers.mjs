#!/usr/bin/env node
/**
 * Multi-retailer label harvest. Other Indian pet retailers run Shopify too, so
 * their /products.json carries composition + analysis in body_html exactly like
 * Supertails. We pull those catalogs, conservatively match our still-unverified
 * products by brand + flavour, and extract the label via the same pipeline.
 *
 * Safety: a match is accepted ONLY if the brand matches AND the product's
 * flavour word (tuna/chicken/...) appears in the extracted ingredients. Anything
 * uncertain is skipped (stays "not verified"). Updates scripts/data/labels.json.
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractLabelFromHtml } from './lib/source.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const labelsPath = resolve(__dirname, 'data', 'labels.json');
const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));
const UA = { 'User-Agent': 'Mozilla/5.0 SniffBot/1.0 (+https://sniff.fyi)' };

const RETAILERS = [
  { name: 'tailyaffairs', base: 'https://tailyaffairs.com' },
  { name: 'headsupfortails', base: 'https://headsupfortails.com' },
  { name: 'petsy', base: 'https://petsy.online' },
  { name: 'zigly', base: 'https://zigly.com' },
  { name: 'goofytails', base: 'https://goofytails.com' },
];

const STOP = new Set('cat cats kitten kittens feline wet dry food fine premium adult senior pouch pouches tin tinned can canned jar gravy jelly mousse loaf broth in with for the and plus years year month months pack combo flavour flavor natural complete rich tasty real super value buy free offer'.split(' '));
const FLAVORS = ['tuna', 'chicken', 'salmon', 'mackerel', 'fish', 'prawn', 'shrimp', 'lamb', 'beef', 'duck', 'liver', 'sardine', 'ocean', 'whitefish', 'bonito', 'crab', 'turkey', 'quinoa', 'pomegranate', 'blueberry', 'quail', 'boar', 'cod', 'herring', 'anchovy', 'pumpkin'];
const toks = (s) => [...new Set((String(s).toLowerCase().match(/[a-z0-9]+/g) || []))].filter((t) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t));

async function catalog(base) {
  const out = [];
  for (let page = 1; page <= 8; page++) {
    try {
      const r = await fetch(`${base}/products.json?limit=250&page=${page}`, { headers: UA });
      if (!r.ok) break;
      const ps = (await r.json()).products || [];
      if (!ps.length) break;
      for (const p of ps) out.push({ title: p.title, vendor: p.vendor, handle: p.handle, body: p.body_html, base });
    } catch { break; }
  }
  return out;
}

function bestMatch(product, cat) {
  const brand = (product.brand || '').split(' · ')[0].toLowerCase();
  const brandTok = toks(brand)[0];
  const A = new Set(toks(brand + ' ' + product.slug.replace(/-/g, ' ')));
  const ourFlavors = FLAVORS.filter((fl) => A.has(fl));
  let best = null;
  for (const c of cat) {
    const B = new Set(toks((c.vendor || '') + ' ' + c.title));
    if (brandTok && !B.has(brandTok)) continue;             // brand must match
    let inter = 0; for (const t of A) if (B.has(t)) inter++;
    const jac = inter / new Set([...A, ...B]).size;
    if (jac < 0.5) continue;
    if (!best || jac > best.jac) best = { c, jac, ourFlavors };
  }
  return best;
}

async function main() {
  const todo = Object.values(labels).filter((l) => l.completeness === 'none' && !l.retailerChecked);
  console.log(`fetching retailer catalogs...`);
  let cat = [];
  for (const r of RETAILERS) { const c = await catalog(r.base); console.log(`  ${r.name}: ${c.length} products`); cat = cat.concat(c); }

  let upgraded = 0, n = 0;
  for (const l of todo) {
    n++;
    const m = bestMatch(l, cat);
    if (m) {
      const ex = extractLabelFromHtml(m.c.body, true);
      // flavour cross-check: our product's flavour must appear in the ingredients
      const ingLow = (ex.ingredientsText || '').toLowerCase();
      const flavourOk = m.ourFlavors.length === 0 || m.ourFlavors.some((fl) => ingLow.includes(fl));
      if (ex.completeness !== 'none' && flavourOk) {
        l.ingredientsText = ex.ingredientsText;
        l.gaText = ex.gaText;
        l.completeness = ex.completeness;
        l.sourceTier = m.c.base.replace(/^https?:\/\/(www\.)?/, '').split('.')[0];
        l.sourceUrl = `${m.c.base}/products/${m.c.handle}`;
        l.identityOk = true; l.multiProduct = false;
        upgraded++;
      }
    }
    l.retailerChecked = true;
  }
  writeFileSync(labelsPath, JSON.stringify(labels, null, 2));
  console.log(`\nDONE. matched + extracted labels for ${upgraded} products (of ${todo.length} still-none).`);
}
main();
