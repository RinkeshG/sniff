#!/usr/bin/env node
/**
 * Cost-efficient residue extractor — NO sub-agents.
 *   Firecrawl search+scrape (renders JS, returns markdown; runs in this script so
 *   page text never enters the main context / Max quota) -> trim to label regions
 *   -> ONE Sonnet call (pay-go API) -> ground verbatim -> existing gate.
 *
 * Run: ANTHROPIC_API_KEY=$(cat /tmp/anthropic_key) node scripts/extract_residue.mjs /tmp/deep_batch1.json
 * Needs /tmp/firecrawl_key. Writes /tmp/residue.sql + /tmp/residue_report.json
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { callClaude, extractJson } from './lib/llm.js';
import { buildAnalysis } from './lib/pipeline.js';

const MODEL = 'claude-sonnet-4-5-20250929';
const FC = readFileSync('/tmp/firecrawl_key', 'utf8').trim();
const batchFile = process.argv[2] || '/tmp/deep_batch1.json';
const slugs = JSON.parse(readFileSync(batchFile, 'utf8'));
const NOW = new Date().toISOString();
const baseBrand = (b) => String(b || '').split('·')[0].trim();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9% ]/g, ' ').replace(/\s+/g, ' ').trim();
const SKIP = /youtube\.|facebook\.|instagram\.|reddit\.|pinterest\./i;

async function fcSearch(q) {
  try {
    const r = await fetch('https://api.firecrawl.dev/v1/search', { method: 'POST', headers: { Authorization: `Bearer ${FC}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, limit: 6 }) });
    const j = await r.json();
    return (j.data || []).map((x) => x.url).filter((u) => u && !SKIP.test(u));
  } catch { return []; }
}
async function fcScrape(url) {
  try {
    const r = await fetch('https://api.firecrawl.dev/v1/scrape', { method: 'POST', headers: { Authorization: `Bearer ${FC}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true, timeout: 25000 }) });
    const j = await r.json();
    return (j.data && j.data.markdown) || '';
  } catch { return ''; }
}
function windows(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const re = /(ingredient|composition|guaranteed analysis|analytical constituent|nutritional|crude protein)/ig;
  const out = []; let m;
  while ((m = re.exec(t)) && out.length < 8) { out.push(t.slice(Math.max(0, m.index - 90), m.index + 650)); re.lastIndex = m.index + 650; }
  return out.join('  ...  ').slice(0, 6500);
}
const PROMPT = (b, combined) => `Extract the REAL ingredient list and guaranteed analysis for this cat product from the text below (from its brand/retail pages).
Product: brand="${baseBrand(b.brand)}", name="${b.title}", form="${b.category}".
Rules: use ONLY text present below; quote ingredient names verbatim and IN ORDER; ignore marketing ("premium","human grade","100% natural","supports immunity"); trust the actual list over the flavour name; for a TREAT with no list you may use the stated protein(s). Return STRICT JSON, nulls if genuinely absent:
{"ingredients":["..."],"gaText":"Crude Protein 30% ... or null","sourceHint":"url","leadIngredient":"... or null"}
TEXT:
"""
${combined}
"""`;
const SQLV = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const J = (o) => `$J$${JSON.stringify(o)}$J$::jsonb`;
function toSQL(slug, r, url) {
  const a = J(r.analysis);
  return `UPDATE products SET analysis=${a}, analysis_v2=${a}, extracted_facts=${r.extracted_facts ? J(r.extracted_facts) : 'NULL'}, ` +
    `data_completeness='${r.data_completeness}', confidence=${r.confidence}, needs_review=${r.needs_review}, ` +
    `source_url=${SQLV(url)}, source_tier='brand-web', source_fetched_at='${NOW}', rubric_version=${SQLV(r.analysis.rubricVersion)} WHERE slug='${slug}';`;
}

const sql = [], report = [];
for (const slug of slugs) {
  if (!existsSync(`/tmp/evidence/${slug}.json`)) { report.push({ slug, status: 'no-bundle' }); continue; }
  const b = JSON.parse(readFileSync(`/tmp/evidence/${slug}.json`, 'utf8'));
  const localText = (b.sources || []).map((s) => `${s.description} ${s.packImageText}`).join(' ');

  const urls = await fcSearch(`${baseBrand(b.brand)} ${b.title} cat food ingredients`);
  let webText = '', usedUrl = null;
  for (const u of urls.slice(0, 4)) {
    const md = await fcScrape(u);
    if (md && /ingredient|composition|crude protein/i.test(md)) { webText += `\n[${u}]\n${md}`; usedUrl = usedUrl || u; if (/crude protein|ingredient/i.test(webText) && webText.length > 1200) break; }
  }
  const combined = windows(`${localText} ${webText}`);
  let parsed = null;
  try { parsed = extractJson(await callClaude(PROMPT(b, combined), { model: MODEL, maxTokens: 800, temperature: 0 })); }
  catch (e) { report.push({ slug, status: 'llm-err', err: String(e).slice(0, 80) }); continue; }
  const ings = (parsed && Array.isArray(parsed.ingredients)) ? parsed.ingredients : [];
  const groundText = norm(`${localText} ${webText}`);
  const grounded = ings.filter((n) => { const x = norm(String(n).split('(')[0]); return x.length >= 2 && groundText.includes(x); });
  const ingredientsText = grounded.length ? grounded.join(', ') : null;
  let gaText = parsed && parsed.gaText ? parsed.gaText : null;
  if (gaText) { const gn = (gaText.match(/\d+(?:\.\d+)?/g) || []); const present = gn.filter((x) => groundText.includes(String(x))); if (!gn.length || present.length < Math.ceil(gn.length / 2)) gaText = null; }

  if (!ingredientsText) { report.push({ slug, status: 'no-grounded', gave: ings.length, url: usedUrl }); continue; }
  const l = { slug, brand: b.brand, title: b.title, category: b.category, life_stage: b.life_stage, type: b.type,
    sourceTier: 'brand-web', sourceUrl: usedUrl, fetchedAt: NOW, completeness: ingredientsText && gaText ? 'full' : 'partial',
    ingredientsText, gaText, identityOk: true, multiProduct: false };
  const r = buildAnalysis(l);
  report.push({ slug, status: 'ok', verdict: r.verdict, completeness: r.data_completeness, first: r.firstIngredient, review: r.needs_review, url: usedUrl });
  if (r.verdict !== 'Not verified yet') sql.push(toSQL(slug, r, usedUrl));
}

writeFileSync('/tmp/residue.sql', sql.join('\n') + (sql.length ? '\n' : ''));
writeFileSync('/tmp/residue_report.json', JSON.stringify(report, null, 2));
const ok = report.filter((r) => r.status === 'ok' && r.verdict !== 'Not verified yet');
console.log(`batch ${slugs.length} | verified ${ok.length} | SQL ${sql.length}`);
for (const r of report) console.log(`  ${(r.verdict || r.status).padEnd(18)} ${(r.first || '').slice(0, 26).padEnd(27)} ${r.slug}`);
