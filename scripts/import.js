#!/usr/bin/env node
/**
 * Stage 4: write built analyses into the STAGING column (analysis_v2) + provenance.
 * Live `analysis` is untouched, so the site keeps serving old data until cutover.
 *
 * Run: SUPABASE_SERVICE_KEY=… ~/.nvm/versions/node/v22.17.0/bin/node scripts/import.js
 * (service key needed because products has row-level security)
 *
 * Reads scripts/data/analyses.json (produced by build.js). Idempotent.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(readFileSync(resolve(__dirname, 'data', 'analyses.json'), 'utf8'));

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hjscicnzlplxpgxzvdex.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!KEY) { console.error('Set SUPABASE_SERVICE_KEY (products has RLS; the publishable key cannot write).'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function patch(r) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/products?slug=eq.${encodeURIComponent(r.slug)}`, {
    method: 'PATCH',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      analysis_v2: r.analysis,
      extracted_facts: r.extracted_facts,
      data_completeness: r.data_completeness,
      confidence: r.confidence,
      source_url: r.sourceUrl,
      source_tier: r.sourceTier,
      source_fetched_at: r.fetchedAt,
      rubric_version: r.analysis.rubricVersion || null,
      needs_review: r.needs_review,
    }),
  });
  if (!res.ok) throw new Error(`${r.slug} ${res.status}: ${await res.text()}`);
}

async function main() {
  console.log(`writing ${rows.length} rows to analysis_v2 staging...`);
  let ok = 0, fail = 0;
  for (let i = 0; i < rows.length; i++) {
    try { await patch(rows[i]); ok++; }
    catch (e) { fail++; console.log('FAIL', e.message); }
    if ((i + 1) % 50 === 0) process.stdout.write(`\r${i + 1}/${rows.length}`);
    await sleep(40);
  }
  console.log(`\ndone. written:${ok} failed:${fail}`);
}
main();
