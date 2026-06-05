#!/usr/bin/env node
/**
 * Re-score every product from its STORED extracted_facts using the current
 * rubric. No re-scraping, no LLM. Deterministic prose only.
 *
 * Read-only by default: prints the before/after verdict distribution and the
 * exact transitions, plus a spot-check. Run with node 18+.
 *
 *   ~/.nvm/versions/node/v22.17.0/bin/node scripts/rescore.mjs
 *   ... scripts/rescore.mjs --slug=applaws-tuna-prawns-70g   # dump one new analysis as JSON
 *
 * Reads use the public anon key (same as the site). Writing is intentionally not
 * done here without an explicit service key + flag.
 */
import { compute } from './lib/compute.js';
import { score } from './lib/rubric.js';
import { assemble } from './lib/schema.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hjscicnzlplxpgxzvdex.supabase.co';
const ANON = process.env.SUPABASE_ANON_KEY || 'sb_publishable_q8CsjF6ub7apLI79mzsc2Q_Hg7-T2IA';
const SERVICE = process.env.SUPABASE_SERVICE_KEY;
const args = process.argv.slice(2);
const SLUG = (args.find((a) => a.startsWith('--slug=')) || '').split('=')[1];
const WRITE = args.includes('--write'); // writes to the analysis_v2 STAGING column, never live

const H = { apikey: ANON, Authorization: `Bearer ${ANON}` };

async function writeStaging(slug, analysis) {
  if (!SERVICE) throw new Error('--write needs SUPABASE_SERVICE_KEY in env');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/products?slug=eq.${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ analysis_v2: analysis, rubric_version: analysis.rubricVersion }),
  });
  if (!r.ok) throw new Error(`write ${slug} ${r.status}: ${await r.text()}`);
}

async function getAll() {
  const cols = 'slug,brand,title,category,life_stage,data_completeness,extracted_facts,analysis';
  let out = [], from = 0, page = 1000;
  for (;;) {
    const url = `${SUPABASE_URL}/rest/v1/products?type=eq.cat&select=${cols}&order=slug`;
    const r = await fetch(url, { headers: { ...H, Range: `${from}-${from + page - 1}` } });
    if (!r.ok) throw new Error(`read ${r.status}: ${await r.text()}`);
    const rows = await r.json();
    out = out.concat(rows);
    if (rows.length < page) break;
    from += page;
  }
  return out;
}

function rescoreRow(p) {
  if (!p.extracted_facts || p.data_completeness === 'none') return null;
  const meta = { brand: p.brand, title: p.title, productType: p.category, lifeStage: p.life_stage, slug: p.slug };
  const computed = compute(p.extracted_facts, meta);
  const skeleton = score(computed);
  const prov = (p.analysis && p.analysis.provenance) || {};
  const provenance = { ...prov, productForm: p.category, rubricVersion: skeleton.rubricVersion };
  const fresh = assemble(skeleton, null, provenance);

  // Preserve the existing WARM (LLM) prose whenever the verdict is unchanged:
  // keep the old analysis as-is and only graft on the new transparency signal +
  // version. Only foods whose verdict actually changed get re-written with plain
  // deterministic prose. This keeps quality high where it's safe.
  const oldA = p.analysis;
  const oldLabel = oldA && oldA.verdict && oldA.verdict.label;
  if (oldA && !oldA.unverified && oldLabel === fresh.verdict.label) {
    const merged = { ...oldA, transparency: fresh.transparency, rubricVersion: skeleton.rubricVersion };
    if (merged.provenance) merged.provenance = { ...merged.provenance, rubricVersion: skeleton.rubricVersion };
    return { analysis: merged, computed, mode: 'kept-prose' };
  }
  return { analysis: fresh, computed, mode: 'rewrote' };
}

const rows = await getAll();

if (SLUG) {
  const p = rows.find((r) => r.slug === SLUG);
  if (!p) { console.error('not found:', SLUG); process.exit(1); }
  const res = rescoreRow(p);
  console.log(JSON.stringify(res ? res.analysis : { note: 'no facts / unverified' }, null, 2));
  process.exit(0);
}

const before = {}, after = {}, moves = {};
let changed = 0, scored = 0, written = 0, keptProse = 0, rewrote = 0;
const sample = [];
for (const p of rows) {
  const res = rescoreRow(p);
  if (!res) continue;
  scored++;
  if (res.mode === 'kept-prose') keptProse++; else rewrote++;
  if (WRITE) { await writeStaging(p.slug, res.analysis); written++; }
  const oldL = (p.analysis && p.analysis.verdict && p.analysis.verdict.label) || '(none)';
  const newL = res.analysis.verdict.label;
  before[oldL] = (before[oldL] || 0) + 1;
  after[newL] = (after[newL] || 0) + 1;
  if (oldL !== newL) {
    changed++;
    const k = `${oldL}  ->  ${newL}`;
    moves[k] = (moves[k] || 0) + 1;
  }
  if (/applaws-tuna|farmina-matisse-kitten|drools-ocean|friskies/.test(p.slug) && sample.length < 8) {
    sample.push({ slug: p.slug, old: oldL, neu: newL, trans: res.analysis.transparency && res.analysis.transparency.label, ing: res.computed.firstIngredient });
  }
}

const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `   ${String(v).padStart(4)}  ${k}`).join('\n');
console.log(`\nScored ${scored} verified products. ${changed} verdicts changed. (kept warm prose: ${keptProse}, rewrote: ${rewrote})\n`);
console.log('BEFORE (live):\n' + fmt(before));
console.log('\nAFTER (new rubric):\n' + fmt(after));
console.log('\nTRANSITIONS:\n' + fmt(moves));
console.log('\nSPOT CHECK:');
for (const s of sample) console.log(`   ${s.old} -> ${s.neu}  [transparency ${s.trans}]  ${s.slug}  (${s.ing})`);
console.log(WRITE ? `\nWROTE ${written} analyses to analysis_v2 (staging). Live 'analysis' untouched.` : '\n(read-only — pass --write to stage into analysis_v2)');
console.log('');
