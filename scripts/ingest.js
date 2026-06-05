#!/usr/bin/env node
/**
 * Sniff ingestion: build label-backed, conviction-or-abstain analyses.
 *
 * Requires Node 18+ (global fetch). If your default `node` is older, run with a
 * newer one, e.g.:  ~/.nvm/versions/node/v22.17.0/bin/node scripts/ingest.js --dry-run
 *
 * Env:
 *   ANTHROPIC_API_KEY     required (extraction + voice)
 *   SUPABASE_URL          required
 *   SUPABASE_SERVICE_KEY  required for writes (RLS); reads can use SUPABASE_KEY
 *
 * Flags:
 *   --dry-run        do everything except write to the DB (prints a table)
 *   --only="text"    only products whose brand/title contains text
 *   --slug=foo       a single product by slug
 *   --limit=N        cap the number processed
 *   --sleep=ms       delay between products (default 1200)
 *
 * Writes go to STAGING columns (analysis_v2 + provenance), never the live
 * `analysis`, so the site keeps serving old data until you cut over.
 */

import { fetchLabel } from './lib/source.js';
import { extractFacts } from './lib/extract.js';
import { validateFacts } from './lib/validate.js';
import { compute } from './lib/compute.js';
import { score, RUBRIC_VERSION } from './lib/rubric.js';
import { voiceOver } from './lib/voice.js';
import { assemble, abstainAnalysis } from './lib/schema.js';

if (typeof fetch !== 'function') {
  console.error('This script needs Node 18+ (global fetch). Run it with a newer node.');
  process.exit(1);
}

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => args.find((a) => a.startsWith(f + '='))?.split('=').slice(1).join('=');
const DRY = has('--dry-run');
const ONLY = val('--only');
const SLUG = val('--slug');
const LIMIT = parseInt(val('--limit') || '0', 10);
const SLEEP = parseInt(val('--sleep') || '1200', 10);

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hjscicnzlplxpgxzvdex.supabase.co';
const READ_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const WRITE_KEY = process.env.SUPABASE_SERVICE_KEY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getProducts() {
  let url = `${SUPABASE_URL}/rest/v1/products?select=slug,brand,title,product_link,category,life_stage&type=eq.cat&order=slug`;
  if (SLUG) url += `&slug=eq.${encodeURIComponent(SLUG)}`;
  const r = await fetch(url, { headers: { apikey: READ_KEY, Authorization: `Bearer ${READ_KEY}` } });
  if (!r.ok) throw new Error(`read products ${r.status}: ${await r.text()}`);
  let rows = await r.json();
  if (ONLY) {
    const q = ONLY.toLowerCase();
    rows = rows.filter((p) => `${p.brand} ${p.title}`.toLowerCase().includes(q));
  }
  if (LIMIT > 0) rows = rows.slice(0, LIMIT);
  return rows;
}

async function writeRow(slug, patch) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/products?slug=eq.${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    headers: { apikey: WRITE_KEY, Authorization: `Bearer ${WRITE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`write ${slug} ${r.status}: ${await r.text()}`);
}

// The conviction gate. We abstain (placeholder) only when there is no usable
// label, or when a list existed but could not be trusted. A partial label
// (ingredients-only or GA-only) still renders, with honest gaps.
const STRONG_LABELS = new Set(['Strong choice']);
function gate(source, validation, label) {
  const errors = [...validation.errors];
  const hadList = !!source.ingredientsText;
  const untrustworthyList = hadList && !validation.firstIngredientValid;

  if (source.completeness === 'none' || untrustworthyList) {
    return { dataCompleteness: 'none', confident: false, confidence: 0, needsReview: source.multiProduct || untrustworthyList, errors };
  }
  const full = source.completeness === 'full';
  const confident =
    validation.firstIngredientValid && label !== 'Not transparent enough' &&
    source.identityOk && !source.multiProduct &&
    (!STRONG_LABELS.has(label) || full);
  return {
    dataCompleteness: full ? 'full' : 'partial',
    confident,
    confidence: confident ? (full ? 1 : 0.65) : 0.3,
    needsReview: source.multiProduct || errors.length > 0,
    errors,
  };
}

async function processOne(product) {
  const meta = { brand: product.brand, title: product.title, productType: product.category, lifeStage: product.life_stage, slug: product.slug };
  const source = await fetchLabel(product);
  const provenance = { source: source.sourceTier, sourceUrl: source.sourceUrl, checkedAt: source.fetchedAt, completeness: source.completeness, rubricVersion: RUBRIC_VERSION };

  let analysis, computed = null, voiceUsed = false;
  let validation = { facts: null, errors: [], firstIngredientValid: false };

  if (source.completeness !== 'none') {
    const raw = await extractFacts({ ingredientsText: source.ingredientsText, gaText: source.gaText });
    validation = validateFacts(raw, { ingredientsText: source.ingredientsText || '', gaText: source.gaText || '' });
    const untrustworthyList = !!source.ingredientsText && !validation.firstIngredientValid;
    if (!untrustworthyList) {
      computed = compute(validation.facts, meta);
      const skeleton = score(computed);
      const v = await voiceOver(meta, computed, skeleton);
      voiceUsed = !!v;
      analysis = assemble(skeleton, v, provenance);
    }
  }

  const label = analysis ? analysis.verdict.label : 'Not transparent enough';
  const g = gate(source, validation, label);
  if (!analysis || g.dataCompleteness === 'none') analysis = abstainAnalysis(meta, provenance);

  return {
    slug: product.slug,
    analysis,
    extractedFacts: validation.facts || null,
    dataCompleteness: g.dataCompleteness,
    confidence: g.confidence,
    needsReview: g.needsReview,
    sourceUrl: source.sourceUrl,
    sourceTier: source.sourceTier,
    fetchedAt: source.fetchedAt,
    voiceUsed,
    computed,
    errors: g.errors,
  };
}

async function main() {
  if (!READ_KEY) { console.error('Set SUPABASE_SERVICE_KEY (or SUPABASE_KEY) to read products.'); process.exit(1); }
  if (!DRY && !WRITE_KEY) { console.error('Writing requires SUPABASE_SERVICE_KEY. Use --dry-run to preview.'); process.exit(1); }
  if (!process.env.ANTHROPIC_API_KEY) { console.error('Set ANTHROPIC_API_KEY.'); process.exit(1); }

  const products = await getProducts();
  console.log(`\n${products.length} products to process${DRY ? ' (dry run)' : ''}\n`);

  const tally = { full: 0, partial: 0, none: 0, needsReview: 0, voice: 0, fail: 0 };
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    process.stdout.write(`[${i + 1}/${products.length}] ${p.slug} ... `);
    try {
      const res = await processOne(p);
      tally[res.dataCompleteness]++;
      if (res.needsReview) tally.needsReview++;
      if (res.voiceUsed) tally.voice++;

      const c = res.computed;
      const summary = res.dataCompleteness === 'none'
        ? 'NOT VERIFIED'
        : `${res.analysis.verdict.label} | ${c ? (c.firstIngredient || '?') : '?'} | P:${c?.proteinDM ?? '-'} C:${c?.carbs ?? '-'} grainFree:${c?.grainFree}`;
      console.log(`${res.dataCompleteness}${res.needsReview ? '*' : ''} | ${summary}`);

      if (!DRY) {
        await writeRow(p.slug, {
          analysis_v2: res.analysis,
          extracted_facts: res.extractedFacts,
          data_completeness: res.dataCompleteness,
          confidence: res.confidence,
          source_url: res.sourceUrl,
          source_tier: res.sourceTier,
          source_fetched_at: res.fetchedAt,
          rubric_version: RUBRIC_VERSION,
          needs_review: res.needsReview,
        });
      }
    } catch (err) {
      tally.fail++;
      console.log(`FAIL ${err.message}`);
    }
    if (i < products.length - 1) await sleep(SLEEP);
  }

  console.log(`\n────────────────────────────`);
  console.log(`full: ${tally.full}  partial: ${tally.partial}  not-verified: ${tally.none}`);
  console.log(`needs-review: ${tally.needsReview}  voice-applied: ${tally.voice}  failed: ${tally.fail}`);
  console.log(DRY ? '(dry run — nothing written)' : 'written to analysis_v2 staging.');
}

main();
