#!/usr/bin/env node
/**
 * Second retailer source: The Pet Project (thepetproject.com), a Shopify store
 * whose product pages often carry the FULL label in text (ingredients + a real
 * guaranteed analysis with %), where Supertails had partial/none.
 *
 * For each unverified cat product we exact-match it in The Pet Project catalog
 * (same brand vendor + identical flavour/named-meat set, cat, not a combo), read
 * the label (body_html text first, pack-image OCR second), and run the SAME gate.
 *
 *   node scripts/harvest_petproject.mjs           # text-only (fast)
 *   node scripts/harvest_petproject.mjs --images  # + pack-image OCR fallback
 *
 * Writes /tmp/petproject.sql + /tmp/petproject_recovered.json. NO DB writes.
 */
import { writeFileSync } from 'fs';
import { buildAnalysis } from './lib/pipeline.js';
import { parseLabel } from './lib/parse.js';
import { extractLabelFromHtml } from './lib/source.js';
import { fetchShopifyCatalog, matchExact, ocrImages, extractIngredients, extractSingleMeat, extractGA } from './lib/labelharvest.js';

const SB = 'https://hjscicnzlplxpgxzvdex.supabase.co';
const KEY = 'sb_publishable_q8CsjF6ub7apLI79mzsc2Q_Hg7-T2IA';
const NOW = new Date().toISOString();
const DOMAIN = 'thepetproject.com';
const DO_IMAGES = process.argv.includes('--images');

const norm2 = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const baseBrand = (b) => String(b || '').split('·')[0].trim();

async function targets() {
  const url = `${SB}/rest/v1/products?select=slug,brand,title,category,life_stage,type&data_completeness=eq.none&type=eq.cat&order=slug&limit=3000`;
  return (await (await fetch(url, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })).json());
}
function brandMatch(base, p) {
  const nb = norm2(base), nv = norm2(p.vendor || '');
  if (nb && nv && (nv === nb || nv.includes(nb) || nb.includes(nv))) return true;
  const w = base.toLowerCase().split(/\s+/)[0];
  return w.length >= 4 && norm2(p.title).includes(norm2(w));
}
function acceptGA(g) { return g && parseLabel({ ingredientsText: '', gaText: g }).ga.protein != null ? g : null; }
const SQLV = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const J = (o) => `$J$${JSON.stringify(o)}$J$::jsonb`;
function toSQL(slug, r, url, tier) {
  const a = J(r.analysis);
  return `UPDATE products SET analysis=${a}, analysis_v2=${a}, extracted_facts=${r.extracted_facts ? J(r.extracted_facts) : 'NULL'}, ` +
    `data_completeness='${r.data_completeness}', confidence=${r.confidence}, needs_review=${r.needs_review}, ` +
    `source_url=${SQLV(url)}, source_tier='${tier}', source_fetched_at='${NOW}', rubric_version=${SQLV(r.analysis.rubricVersion)} WHERE slug='${slug}';`;
}

const tg = await targets();
const catalog = await fetchShopifyCatalog(DOMAIN);
console.log(`unverified: ${tg.length} | ${DOMAIN} catalog: ${catalog.length} | mode: ${DO_IMAGES ? 'text+image' : 'text'}\n`);

const sql = [], recovered = [];
let matched = 0;
for (const t of tg) {
  const subset = catalog.filter((p) => brandMatch(baseBrand(t.brand), p));
  if (!subset.length) continue;
  const m = matchExact(t, subset, []);
  if (!m) continue;
  matched++;
  const url = `https://${DOMAIN}/products/${m.handle}`;
  let ingredientsText = null, gaText = null, tier = 'thepetproject';
  const ex = extractLabelFromHtml(m.body_html, true);
  if (ex.ingredientsText) { ingredientsText = ex.ingredientsText; gaText = acceptGA(ex.gaText); }
  if (!ingredientsText && DO_IMAGES) {
    const ocr = await ocrImages((m.images || []).map((i) => i.src), `/tmp/tppimg/${t.slug}`);
    const ing = extractIngredients(ocr); ingredientsText = ing.text;
    if (!ingredientsText && t.category === 'treat') { const sm = extractSingleMeat(ocr, t); if (sm) ingredientsText = sm; }
    if (ingredientsText) { gaText = acceptGA(extractGA(ocr)); tier = 'pack-photo'; }
  }
  if (!ingredientsText) continue;
  const l = { slug: t.slug, brand: t.brand, title: t.title, category: t.category, life_stage: t.life_stage, type: t.type,
    sourceTier: tier, sourceUrl: url, fetchedAt: NOW, completeness: ingredientsText && gaText ? 'full' : 'partial',
    ingredientsText, gaText, identityOk: true, multiProduct: ex.multiProduct };
  const r = buildAnalysis(l);
  if (r.verdict === 'Not verified yet') continue;
  sql.push(toSQL(t.slug, r, url, tier));
  recovered.push({ slug: t.slug, match: m.title, verdict: r.verdict, completeness: r.data_completeness, first: r.firstIngredient, review: r.needs_review, proteinDM: r.proteinDM });
}

writeFileSync('/tmp/petproject.sql', sql.join('\n') + (sql.length ? '\n' : ''));
writeFileSync('/tmp/petproject_recovered.json', JSON.stringify(recovered, null, 2));
console.log(`matched in catalog: ${matched} | RECOVERED: ${recovered.length}`);
const full = recovered.filter((r) => r.completeness === 'full').length;
const rev = recovered.filter((r) => r.review).length;
console.log(`full-GA: ${full} | needs_review: ${rev}`);
for (const r of recovered) console.log(`  ${(r.verdict||'').padEnd(18)} ${(r.completeness||'').padEnd(7)} ${r.review?'[REVIEW] ':'         '}${(r.first||'').slice(0,32).padEnd(33)} ${r.slug}`);
