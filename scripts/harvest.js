#!/usr/bin/env node
/**
 * Stage 1: harvest real labels. Reads every cat product, fetches its Supertails
 * .json, and records the isolated Composition + Guaranteed Analysis text.
 * Network only, NO keys (products read with the publishable key; pages are public).
 *
 * Run: ~/.nvm/versions/node/v22.17.0/bin/node scripts/harvest.js
 * Resumable: re-running skips slugs already in scripts/data/labels.json.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fetchSupertailsLabel } from './lib/source.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, 'data');
const OUT = resolve(DATA, 'labels.json');
mkdirSync(DATA, { recursive: true });

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hjscicnzlplxpgxzvdex.supabase.co';
const KEY = process.env.SUPABASE_KEY || 'sb_publishable_q8CsjF6ub7apLI79mzsc2Q_Hg7-T2IA';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function allProducts() {
  const cols = 'slug,brand,title,product_link,category,life_stage';
  const url = `${SUPABASE_URL}/rest/v1/products?select=${cols}&type=eq.cat&order=slug&limit=2000`;
  const r = await fetch(url, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`read products ${r.status}: ${await r.text()}`);
  return r.json();
}

async function main() {
  let done = {};
  try { done = JSON.parse(readFileSync(OUT, 'utf8')); } catch { /* fresh */ }

  const products = await allProducts();
  // Re-fetch anything not yet harvested OR previously 'none' (parser may have improved).
  const todo = products.filter((p) => !done[p.slug] || done[p.slug].completeness === 'none');
  console.log(`${products.length} cat products, ${Object.keys(done).length} harvested, ${todo.length} to go`);

  for (let i = 0; i < todo.length; i++) {
    const p = todo[i];
    try {
      const s = await fetchSupertailsLabel(p);
      done[p.slug] = {
        slug: p.slug, brand: p.brand, title: p.title, product_link: p.product_link,
        category: p.category, life_stage: p.life_stage,
        ingredientsText: s.ingredientsText, gaText: s.gaText,
        completeness: s.completeness, identityOk: s.identityOk, multiProduct: s.multiProduct,
        sourceUrl: s.sourceUrl, sourceTier: s.sourceTier, fetchedAt: s.fetchedAt,
      };
    } catch (e) {
      done[p.slug] = { slug: p.slug, brand: p.brand, title: p.title, product_link: p.product_link, category: p.category, life_stage: p.life_stage, completeness: 'none', error: e.message };
    }
    if ((i + 1) % 20 === 0 || i === todo.length - 1) {
      writeFileSync(OUT, JSON.stringify(done, null, 2));
      process.stdout.write(`\r[${i + 1}/${todo.length}] harvested`);
    }
    await sleep(300);
  }
  writeFileSync(OUT, JSON.stringify(done, null, 2));

  const vals = Object.values(done);
  const tally = vals.reduce((a, v) => (a[v.completeness] = (a[v.completeness] || 0) + 1, a), {});
  console.log(`\nDone. full:${tally.full || 0} partial:${tally.partial || 0} none:${tally.none || 0}`);
}
main();
