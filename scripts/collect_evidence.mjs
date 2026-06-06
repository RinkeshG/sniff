#!/usr/bin/env node
/**
 * Evidence Collector — the "gather everything" stage of the new pipeline.
 *
 * For each unverified cat product, pull ALL the raw text we can get from every
 * source and dump it into one bundle: Supertails description + OCR of every pack
 * image, and The Pet Project (when an exact catalog match exists) description +
 * image OCR. No filtering, no keyword rules — that is the extractor's job. We
 * just collect, so a downstream reader can make sense of it.
 *
 * Resumable: skips products whose bundle already exists.
 * Run: ~/.nvm/.../node scripts/collect_evidence.mjs
 * Writes /tmp/evidence/<slug>.json
 */
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { fetchShopifyCatalog, matchExact, ocrImages } from './lib/labelharvest.js';

const SB = 'https://hjscicnzlplxpgxzvdex.supabase.co';
const KEY = 'sb_publishable_q8CsjF6ub7apLI79mzsc2Q_Hg7-T2IA';
const UA = { 'User-Agent': 'Mozilla/5.0 SniffBot/1.0 (+https://sniff.fyi)' };
const OUT = '/tmp/evidence';
mkdirSync(OUT, { recursive: true });

// Minimal, readable HTML -> text (keeps block breaks; we want the description as
// a human would read it, not perfectly structured).
function htmlText(html) {
  return String(html || '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d|\/tr)\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}
const baseBrand = (b) => String(b || '').split('·')[0].trim();
const norm2 = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const handleOf = (link, slug) => (String(link || '').match(/\/products\/([^/?#]+)/) || [null, slug])[1];

async function targets() {
  const url = `${SB}/rest/v1/products?select=slug,brand,title,category,life_stage,type,product_link&data_completeness=eq.none&type=eq.cat&order=slug&limit=3000`;
  return (await (await fetch(url, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })).json());
}
function brandMatch(base, p) {
  const nb = norm2(base), nv = norm2(p.vendor || '');
  if (nb && nv && (nv === nb || nv.includes(nb) || nb.includes(nv))) return true;
  const w = base.toLowerCase().split(/\s+/)[0];
  return w.length >= 4 && norm2(p.title).includes(norm2(w));
}

// gather one Shopify product page (text + image OCR) into a source record
async function gatherShopify(source, base, handle, p, slug) {
  if (!p) return null;
  const desc = htmlText(p.body_html);
  let ocr = '';
  try {
    const raw = await ocrImages((p.images || []).slice(0, 12).map((i) => i.src), `/tmp/evidence_img/${slug}-${source}`);
    // flatten OCR file markers into readable text
    ocr = raw.split('@@@FILE@@@').slice(1)
      .map((ch) => ch.slice(ch.indexOf('\n') + 1).split('@@@END@@@')[0].replace(/\s+/g, ' ').trim())
      .filter(Boolean).join('\n--- (next pack image) ---\n');
  } catch { /* OCR best-effort */ }
  return { source, url: base, title: p.title, vendor: p.vendor || null,
    description: desc, packImageText: ocr };
}

const tg = await targets();
console.log(`unverified cats: ${tg.length}`);
const tpp = await fetchShopifyCatalog('thepetproject.com');
console.log(`pet project catalog: ${tpp.length}\n`);

let done = 0, skipped = 0;
for (const t of tg) {
  const out = `${OUT}/${t.slug}.json`;
  if (existsSync(out)) { skipped++; continue; }
  const bundle = { slug: t.slug, brand: t.brand, title: t.title, category: t.category, life_stage: t.life_stage, type: t.type, sources: [] };

  // Source 1: Supertails (the product's own page — always exact)
  const h = handleOf(t.product_link, t.slug);
  try {
    const p = (await (await fetch(`https://supertails.com/products/${h}.json`, { headers: UA })).json()).product;
    const rec = await gatherShopify('supertails', t.product_link || `https://supertails.com/products/${h}`, h, p, t.slug);
    if (rec) bundle.sources.push(rec);
  } catch { /* skip */ }

  // Source 2: The Pet Project (exact catalog match only)
  try {
    const subset = tpp.filter((p) => brandMatch(baseBrand(t.brand), p));
    const m = subset.length ? matchExact(t, subset, []) : null;
    if (m) {
      const rec = await gatherShopify('thepetproject', `https://thepetproject.com/products/${m.handle}`, m.handle, m, t.slug);
      if (rec) bundle.sources.push(rec);
    }
  } catch { /* skip */ }

  writeFileSync(out, JSON.stringify(bundle, null, 2));
  done++;
  if (done % 10 === 0) console.log(`  collected ${done} (skipped ${skipped})...`);
}
console.log(`\nDONE. collected ${done}, skipped ${skipped} (already had bundles). -> ${OUT}/`);
