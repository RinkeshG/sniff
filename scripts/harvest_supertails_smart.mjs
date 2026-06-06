#!/usr/bin/env node
/**
 * Smart re-harvest of ALL unverified cat products from the Supertails page we
 * ALREADY point to (product_link). The label is usually right there in the
 * description text (single-ingredient, run-on "Ingredients:" lines, or a real
 * GA) or in the pack images. We read text first, fall back to image OCR, run the
 * SAME gate (lib/pipeline.js), and only conclude "unverified" after both fail.
 *
 *   node scripts/harvest_supertails_smart.mjs           # text-only (fast)
 *   node scripts/harvest_supertails_smart.mjs --images  # + pack-image OCR fallback
 *
 * Writes /tmp/supertails_smart.sql (verified) and /tmp/still_none.json (remaining).
 * NO DB writes.
 */
import { writeFileSync } from 'fs';
import { buildAnalysis } from './lib/pipeline.js';
import { parseLabel } from './lib/parse.js';
import { extractLabelFromHtml } from './lib/source.js';
import { ocrImages, extractIngredients, extractSingleMeat, extractGA, UA } from './lib/labelharvest.js';

const SB = 'https://hjscicnzlplxpgxzvdex.supabase.co';
const KEY = 'sb_publishable_q8CsjF6ub7apLI79mzsc2Q_Hg7-T2IA';
const NOW = new Date().toISOString();
const DO_IMAGES = process.argv.includes('--images');

async function targets() {
  const url = `${SB}/rest/v1/products?select=slug,brand,title,category,life_stage,type,product_link&data_completeness=eq.none&type=eq.cat&order=slug&limit=3000`;
  return (await (await fetch(url, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })).json());
}
const handleOf = (link, slug) => (String(link || '').match(/\/products\/([^/?#]+)/) || [null, slug])[1];
function acceptGA(gaCand) {
  if (!gaCand) return null;
  return parseLabel({ ingredientsText: '', gaText: gaCand }).ga.protein != null ? gaCand : null;
}
const SQLV = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const J = (o) => `$J$${JSON.stringify(o)}$J$::jsonb`;
function toSQL(slug, r, sourceUrl, tier) {
  const a = J(r.analysis);
  return `UPDATE products SET analysis=${a}, analysis_v2=${a}, extracted_facts=${r.extracted_facts ? J(r.extracted_facts) : 'NULL'}, ` +
    `data_completeness='${r.data_completeness}', confidence=${r.confidence}, needs_review=${r.needs_review}, ` +
    `source_url=${SQLV(sourceUrl)}, source_tier='${tier}', source_fetched_at='${NOW}', rubric_version=${SQLV(r.analysis.rubricVersion)} WHERE slug='${slug}';`;
}

const tg = await targets();
console.log(`unverified cat products: ${tg.length}  | mode: ${DO_IMAGES ? 'text + image OCR' : 'text-only'}\n`);

const sql = [], recovered = [], stillNone = [];
let done = 0;
for (const t of tg) {
  done++;
  const handle = handleOf(t.product_link, t.slug);
  const sourceUrl = t.product_link || `https://supertails.com/products/${handle}`;
  let p = null;
  try { p = (await (await fetch(`https://supertails.com/products/${handle}.json`, { headers: UA })).json()).product; } catch { /* ignore */ }
  if (!p) { stillNone.push(t.slug); continue; }

  let ingredientsText = null, gaText = null, tier = 'supertails';
  const ex = extractLabelFromHtml(p.body_html, true);
  if (ex.ingredientsText) { ingredientsText = ex.ingredientsText; gaText = acceptGA(ex.gaText); }

  if (!ingredientsText && DO_IMAGES) {
    const ocr = await ocrImages((p.images || []).map((i) => i.src), `/tmp/stimg/${t.slug}`);
    const ing = extractIngredients(ocr);
    ingredientsText = ing.text;
    if (!ingredientsText && t.category === 'treat') { const sm = extractSingleMeat(ocr, t); if (sm) ingredientsText = sm; }
    if (ingredientsText) { gaText = acceptGA(extractGA(ocr)); tier = 'pack-photo'; }
  }

  if (!ingredientsText) { stillNone.push(t.slug); continue; }

  const l = {
    slug: t.slug, brand: t.brand, title: t.title, category: t.category, life_stage: t.life_stage, type: t.type,
    sourceTier: tier, sourceUrl, fetchedAt: NOW, completeness: ingredientsText && gaText ? 'full' : 'partial',
    ingredientsText, gaText, identityOk: true, multiProduct: ex.multiProduct,
  };
  const r = buildAnalysis(l);
  if (r.verdict === 'Not verified yet') { stillNone.push(t.slug); continue; }
  sql.push(toSQL(t.slug, r, sourceUrl, tier));
  recovered.push({ slug: t.slug, verdict: r.verdict, completeness: r.data_completeness, first: r.firstIngredient, tier, review: r.needs_review });
}

writeFileSync('/tmp/supertails_smart.sql', sql.join('\n') + (sql.length ? '\n' : ''));
writeFileSync('/tmp/still_none.json', JSON.stringify(stillNone, null, 2));
console.log(`RECOVERED ${recovered.length} / ${tg.length}   (still unverified: ${stillNone.length})`);
const byV = {}; for (const r of recovered) byV[r.verdict] = (byV[r.verdict] || 0) + 1;
console.log('verdicts:', byV);
console.log('\nsample recovered:');
for (const r of recovered.slice(0, 30)) console.log(`  ${r.verdict.padEnd(20)} ${r.completeness.padEnd(8)} ${r.first ? '('+r.first+')' : ''}  ${r.slug}`);
