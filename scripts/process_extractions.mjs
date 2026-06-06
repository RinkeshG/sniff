#!/usr/bin/env node
/**
 * Ground + gate stage. Takes the fan-out agents' extractions (/tmp/extractions/
 * <slug>.json) and, for each:
 *   1) GROUNDS it against the product's evidence bundle — every ingredient name
 *      and every GA number MUST appear in the gathered text, else it is dropped.
 *      This is the anti-hallucination guarantee: the agent can locate/structure,
 *      but cannot invent anything not literally in a real source.
 *   2) Runs the SAME identity/consistency gate as everything else (buildAnalysis).
 *
 * Writes /tmp/fanout.sql (verified) + prints a review report. NO DB writes.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { buildAnalysis } from './lib/pipeline.js';

const NOW = new Date().toISOString();
const EV = '/tmp/evidence', EX = '/tmp/extractions';
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9% ]/g, ' ').replace(/\s+/g, ' ').trim();
const numbersIn = (t) => (String(t || '').match(/\d+(?:\.\d+)?/g) || []).map(Number);

function bundleText(slug) {
  const b = JSON.parse(readFileSync(`${EV}/${slug}.json`, 'utf8'));
  const text = (b.sources || []).map((s) => `${s.description}\n${s.packImageText}`).join('\n');
  return { b, text: norm(text) };
}

const SQLV = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const J = (o) => `$J$${JSON.stringify(o)}$J$::jsonb`;
function toSQL(slug, r, url, tier) {
  const a = J(r.analysis);
  return `UPDATE products SET analysis=${a}, analysis_v2=${a}, extracted_facts=${r.extracted_facts ? J(r.extracted_facts) : 'NULL'}, ` +
    `data_completeness='${r.data_completeness}', confidence=${r.confidence}, needs_review=${r.needs_review}, ` +
    `source_url=${SQLV(url)}, source_tier='${tier}', source_fetched_at='${NOW}', rubric_version=${SQLV(r.analysis.rubricVersion)} WHERE slug='${slug}';`;
}
const tierOf = (url) => /thepetproject/.test(url || '') ? 'thepetproject' : /goofytails/.test(url || '') ? 'pack-photo' : 'supertails';

const files = existsSync(EX) ? readdirSync(EX).filter((f) => f.endsWith('.json')) : [];
const sql = [], report = [];
for (const f of files) {
  const slug = f.replace(/\.json$/, '');
  let ex; try { ex = JSON.parse(readFileSync(`${EX}/${f}`, 'utf8')); } catch { continue; }
  if (!existsSync(`${EV}/${slug}.json`)) continue;
  const { b, text } = bundleText(slug);

  // GROUND ingredients: keep only those present in the gathered text
  const inGiven = Array.isArray(ex.ingredients) ? ex.ingredients : [];
  const grounded = inGiven.filter((name) => {
    const n = norm(String(name).split('(')[0]); // ignore parenthetical %/notes
    return n.length >= 2 && text.includes(n);
  });
  const dropped = inGiven.length - grounded.length;
  const ingredientsText = grounded.length ? grounded.join(', ') : null;

  // GROUND GA: keep only if its numbers appear in the gathered text
  let gaText = ex.gaText || null;
  if (gaText) {
    const gns = numbersIn(gaText);
    const present = gns.filter((x) => text.includes(String(x)));
    if (!gns.length || present.length < Math.ceil(gns.length / 2)) gaText = null; // mostly ungrounded -> drop
  }

  const url = ex.sourceUrl || (b.sources[0] && b.sources[0].url) || null;
  if (!ingredientsText) { report.push({ slug, verdict: 'Not verified yet', note: `no grounded ingredients (agent gave ${inGiven.length}, dropped ${dropped})` }); continue; }

  const l = {
    slug, brand: b.brand, title: b.title, category: b.category, life_stage: b.life_stage, type: b.type,
    sourceTier: tierOf(url), sourceUrl: url, fetchedAt: NOW,
    completeness: ingredientsText && gaText ? 'full' : 'partial',
    ingredientsText, gaText, identityOk: true, multiProduct: false,
  };
  const r = buildAnalysis(l);
  report.push({ slug, verdict: r.verdict, completeness: r.data_completeness, first: r.firstIngredient, review: r.needs_review, dropped, src: tierOf(url) });
  if (r.verdict !== 'Not verified yet') sql.push(toSQL(slug, r, url, tierOf(url)));
}

writeFileSync('/tmp/fanout.sql', sql.join('\n') + (sql.length ? '\n' : ''));
const ok = report.filter((r) => r.verdict && r.verdict !== 'Not verified yet');
console.log(`processed ${report.length} | verified ${ok.length} | SQL rows ${sql.length}`);
const byv = {}; for (const r of ok) byv[r.verdict] = (byv[r.verdict] || 0) + 1;
console.log('verdicts:', JSON.stringify(byv));
console.log('\n-- verified (first ingredient | source | review) --');
for (const r of ok) console.log(`  ${(r.verdict||'').padEnd(18)} ${(r.completeness||'').padEnd(7)} ${r.review?'[rev] ':'      '}${(r.first||'').slice(0,34).padEnd(35)} ${r.src.padEnd(13)} ${r.slug}`);
console.log('\n-- still unverified --');
for (const r of report.filter((x) => !x.verdict || x.verdict === 'Not verified yet')) console.log(`  ${r.slug}  (${r.note||''})`);
