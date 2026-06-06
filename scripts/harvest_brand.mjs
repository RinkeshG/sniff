#!/usr/bin/env node
/**
 * Brand-agnostic own-site verifier. Same model as Goofy Tails, generalized:
 *   - read our unverified cat products for ONE brand (Supabase anon read)
 *   - fetch that brand's OWN catalog (Shopify products.json)
 *   - exact-match each product (same descriptors + named-meat set, cat, no combo)
 *   - read its label from the page: body_html TEXT first, image OCR second
 *   - run the SAME identity/consistency gate as build.js (lib/pipeline.js)
 *
 * Conviction-or-abstain throughout; a guaranteed analysis is only used if it
 * yields a real protein %. Writes /tmp/<brand>.sql for review. NO DB writes.
 *
 * Run: ~/.nvm/.../node scripts/harvest_brand.mjs <brandKey>
 *      brandKey one of the keys in BRANDS below (e.g. jinny, carniwel, huft).
 */
import { writeFileSync } from 'fs';
import { buildAnalysis } from './lib/pipeline.js';
import { parseLabel } from './lib/parse.js';
import { extractLabelFromHtml } from './lib/source.js';
import { fetchShopifyCatalog, matchExact, ocrImages, extractIngredients, extractSingleMeat, extractGA, UA } from './lib/labelharvest.js';

const SB = 'https://hjscicnzlplxpgxzvdex.supabase.co';
const KEY = 'sb_publishable_q8CsjF6ub7apLI79mzsc2Q_Hg7-T2IA';
const NOW = new Date().toISOString();

// One entry per own-site-verifiable brand. dbBrand matches the live base brand
// (text before '·'); domain is the Shopify store; tokens restrict the catalog to
// the brand's OWN products on multi-brand stores.
const BRANDS = {
  jinny:       { dbBrand: 'Jinny',              domain: 'jinny.com',          tokens: [] },
  carniwel:    { dbBrand: 'Carniwel',           domain: 'carniwel.com',       tokens: [] },
  huft:        { dbBrand: 'Heads Up for Tails', domain: 'headsupfortails.com', tokens: ['huft', 'meowsi', 'heads up'] },
  barkoutloud: { dbBrand: 'Bark Out Loud',      domain: 'headsupfortails.com', tokens: ['bark out'] },
  purrfeto:    { dbBrand: 'Purrfeto',           domain: 'purrfeto.com',       tokens: [] },
  schesir:     { dbBrand: 'Schesir',            domain: 'schesir.com',        tokens: ['schesir'] },
  datgud:      { dbBrand: 'DatGud',             domain: 'datgud.com',         tokens: [] },
  himalaya:    { dbBrand: 'Himalaya',           domain: 'himalayawellness.in', tokens: ['himalaya'] },
};

const brandKey = process.argv[2];
const cfg = BRANDS[brandKey];
if (!cfg) { console.error(`Unknown brand "${brandKey}". Known: ${Object.keys(BRANDS).join(', ')}`); process.exit(1); }

const baseBrand = (b) => String(b || '').split('·')[0].trim();

async function targets() {
  const url = `${SB}/rest/v1/products?select=slug,brand,title,category,life_stage,type,product_link&data_completeness=eq.none&type=eq.cat&order=slug&limit=3000`;
  const r = await fetch(url, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  const rows = await r.json();
  return rows.filter((x) => baseBrand(x.brand) === cfg.dbBrand);
}

// Accept a GA block only if it yields a real protein % (grams-format -> partial).
function acceptGA(gaCand) {
  if (!gaCand) return null;
  const probe = parseLabel({ ingredientsText: '', gaText: gaCand });
  return probe.ga.protein != null ? gaCand : null;
}

const SQLV = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const J = (o) => `$J$${JSON.stringify(o)}$J$::jsonb`;
function toSQL(slug, r, sourceUrl, tier) {
  const a = J(r.analysis);
  return `UPDATE products SET analysis=${a}, analysis_v2=${a}, extracted_facts=${r.extracted_facts ? J(r.extracted_facts) : 'NULL'}, ` +
    `data_completeness='${r.data_completeness}', confidence=${r.confidence}, needs_review=${r.needs_review}, ` +
    `source_url=${SQLV(sourceUrl)}, source_tier='${tier}', source_fetched_at='${NOW}', rubric_version=${SQLV(r.analysis.rubricVersion)} ` +
    `WHERE slug='${slug}';`;
}

const tg = await targets();
const catalog = await fetchShopifyCatalog(cfg.domain);
console.log(`brand: ${cfg.dbBrand}  | our unverified: ${tg.length}  | ${cfg.domain} catalog: ${catalog.length}\n`);

const sql = [];
let verified = 0, noMatch = 0, noLabel = 0;
for (const target of tg) {
  console.log('─'.repeat(70));
  console.log(`TARGET  ${target.slug}  ("${target.title}")`);
  const match = matchExact(target, catalog, cfg.tokens);
  if (!match) { console.log('  NO EXACT MATCH -> leave "Not verified yet"\n'); noMatch++; continue; }
  const sourceUrl = `https://${cfg.domain}/products/${match.handle}`;
  console.log(`  MATCH  "${match.title}"  ${sourceUrl}`);

  // 1) body_html text first
  let ingredientsText = null, gaText = null, tier = 'brand-site', single = false;
  const fromHtml = extractLabelFromHtml(match.body_html, true);
  if (fromHtml.ingredientsText) {
    ingredientsText = fromHtml.ingredientsText;
    gaText = acceptGA(fromHtml.gaText);
    console.log('  source: body_html text');
  } else {
    // 2) image OCR
    const ocr = await ocrImages((match.images || []).map((i) => i.src), `/tmp/brandimg/${target.slug}`);
    const ing = extractIngredients(ocr);
    ingredientsText = ing.text;
    if (!ingredientsText && target.category === 'treat') {
      const sm = extractSingleMeat(ocr, target);
      if (sm) { ingredientsText = sm; single = true; }
    }
    gaText = acceptGA(extractGA(ocr));
    tier = 'pack-photo';
    console.log(`  source: image OCR${single ? ' (single-ingredient treat)' : ''}`);
  }

  if (!ingredientsText) { console.log('  NO READABLE LABEL on the page -> leave "Not verified yet"\n'); noLabel++; continue; }
  console.log(`  INGREDIENTS: ${ingredientsText}`);

  const completeness = ingredientsText && gaText ? 'full' : 'partial';
  const l = {
    slug: target.slug, brand: target.brand, title: target.title, category: target.category,
    life_stage: target.life_stage, type: target.type,
    sourceTier: tier, sourceUrl, fetchedAt: NOW, completeness,
    ingredientsText, gaText, identityOk: true, multiProduct: false,
  };
  const res = buildAnalysis(l);
  console.log(`  => ${res.verdict}  | ${res.data_completeness} | conf ${res.confidence} | review ${res.needs_review}  | first: ${res.firstIngredient}`);
  if (res.analysis.reviewReason) console.log(`     reviewReason: ${res.analysis.reviewReason}`);
  if (res.verdict !== 'Not verified yet') { sql.push(toSQL(target.slug, res, sourceUrl, tier)); verified++; }
  console.log('');
}

writeFileSync(`/tmp/${brandKey}.sql`, sql.join('\n') + (sql.length ? '\n' : ''));
console.log('═'.repeat(70));
console.log(`${cfg.dbBrand}: ${verified} verifiable / ${tg.length} unverified  (no-match ${noMatch}, no-label ${noLabel}) -> /tmp/${brandKey}.sql`);
