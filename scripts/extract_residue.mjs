#!/usr/bin/env node
/**
 * Cost-efficient residue extractor — NO sub-agents.
 *   render (Playwright, free/local) -> trim to label regions -> ONE Sonnet call
 *   (pay-go API) -> ground verbatim -> existing gate (buildAnalysis).
 * All web text stays in this script (never the main context), so it costs ~0 of
 * the Claude Code Max quota; only the small LLM calls bill to the API.
 *
 * Run: ANTHROPIC_API_KEY=$(cat /tmp/anthropic_key) node scripts/extract_residue.mjs /tmp/deep_batch1.json
 * Writes /tmp/residue.sql + /tmp/residue_report.json
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { callClaude, extractJson } from './lib/llm.js';
import { buildAnalysis } from './lib/pipeline.js';

const MODEL = 'claude-sonnet-4-5-20250929';
const batchFile = process.argv[2] || '/tmp/deep_batch1.json';
const slugs = JSON.parse(readFileSync(batchFile, 'utf8'));
const NOW = new Date().toISOString();
const baseBrand = (b) => String(b || '').split('·')[0].trim();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9% ]/g, ' ').replace(/\s+/g, ' ').trim();

// Keep only text around label keywords, so the LLM input stays small/cheap.
function windows(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const re = /(ingredient|composition|guaranteed analysis|analytical constituent|nutritional|crude protein)/ig;
  const out = []; let m;
  while ((m = re.exec(t)) && out.length < 8) { out.push(t.slice(Math.max(0, m.index - 90), m.index + 650)); re.lastIndex = m.index + 650; }
  return out.join('  ...  ').slice(0, 6000);
}

async function render(page, url) {
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 22000 }); await page.waitForTimeout(1200);
    return await page.evaluate(() => document.body.innerText || ''); } catch { return ''; }
}
async function bingUrls(page, q) {
  try { await page.goto('https://www.bing.com/search?q=' + encodeURIComponent(q), { waitUntil: 'domcontentloaded', timeout: 18000 });
    return await page.evaluate(() => [...document.querySelectorAll('li.b_algo a, h2 a')].map((a) => a.href).filter((h) => /^https?:/.test(h)));
  } catch { return []; }
}
const SKIP = /amazon\.|flipkart\.|supertails\.com|youtube\.|facebook\.|instagram\./i;

const PROMPT = (b, combined) => `Extract the REAL ingredient list and guaranteed analysis for this cat product from the text below (gathered from its retail/brand pages).
Product: brand="${baseBrand(b.brand)}", name="${b.title}", form="${b.category}".
Rules: use ONLY text present below; quote ingredient names verbatim; ignore marketing ("premium","human grade","100% natural","supports immunity"); trust the actual list over the flavour name; for a TREAT with no list you may use the stated protein(s). Return STRICT JSON, nulls if genuinely absent:
{"ingredients":["..."],"gaText":"Crude Protein 30% ... or null","sourceHint":"which source/url","leadIngredient":"... or null"}
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

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' });
const page = await ctx.newPage();

const sql = [], report = [];
for (const slug of slugs) {
  if (!existsSync(`/tmp/evidence/${slug}.json`)) { report.push({ slug, status: 'no-bundle' }); continue; }
  const b = JSON.parse(readFileSync(`/tmp/evidence/${slug}.json`, 'utf8'));
  const localText = (b.sources || []).map((s) => `${s.description} ${s.packImageText}`).join(' ');

  // discover + render web sources (brand site / pawdiet / other retailers)
  let urls = await bingUrls(page, `${baseBrand(b.brand)} ${b.title} cat food ingredients`);
  urls = [...new Set(urls)].filter((u) => !SKIP.test(u)).slice(0, 4);
  let webText = '';
  for (const u of urls) { const t = await render(page, u); if (t && /ingredient|composition|crude protein/i.test(t)) { webText += `\n[${u}]\n${t}`; if (/ingredient/i.test(webText) && webText.length > 1500) break; } }

  const combined = windows(`${localText} ${webText}`);
  let parsed = null;
  try { parsed = extractJson(await callClaude(PROMPT(b, combined), { model: MODEL, maxTokens: 700, temperature: 0 })); } catch (e) { report.push({ slug, status: 'llm-err', err: String(e).slice(0, 80) }); continue; }
  const ings = (parsed && Array.isArray(parsed.ingredients)) ? parsed.ingredients : [];

  // GROUND against everything we actually gathered
  const groundText = norm(`${localText} ${webText}`);
  const grounded = ings.filter((n) => { const x = norm(String(n).split('(')[0]); return x.length >= 2 && groundText.includes(x); });
  const ingredientsText = grounded.length ? grounded.join(', ') : null;
  let gaText = parsed && parsed.gaText ? parsed.gaText : null;
  if (gaText) { const gn = (gaText.match(/\d+(?:\.\d+)?/g) || []); const present = gn.filter((x) => groundText.includes(String(x))); if (!gn.length || present.length < Math.ceil(gn.length / 2)) gaText = null; }

  if (!ingredientsText) { report.push({ slug, status: 'no-grounded', gave: ings.length }); continue; }
  const url = (webText.match(/\[(https?:[^\]]+)\]/) || [])[1] || (b.sources[0] && b.sources[0].url) || null;
  const l = { slug, brand: b.brand, title: b.title, category: b.category, life_stage: b.life_stage, type: b.type,
    sourceTier: 'brand-web', sourceUrl: url, fetchedAt: NOW, completeness: ingredientsText && gaText ? 'full' : 'partial',
    ingredientsText, gaText, identityOk: true, multiProduct: false };
  const r = buildAnalysis(l);
  report.push({ slug, status: 'ok', verdict: r.verdict, completeness: r.data_completeness, first: r.firstIngredient, review: r.needs_review, url });
  if (r.verdict !== 'Not verified yet') sql.push(toSQL(slug, r, url));
}
await browser.close();

writeFileSync('/tmp/residue.sql', sql.join('\n') + (sql.length ? '\n' : ''));
writeFileSync('/tmp/residue_report.json', JSON.stringify(report, null, 2));
const ok = report.filter((r) => r.status === 'ok' && r.verdict !== 'Not verified yet');
console.log(`batch ${slugs.length} | verified ${ok.length} | SQL ${sql.length}`);
for (const r of report) console.log(`  ${(r.verdict||r.status).padEnd(18)} ${(r.first||'').slice(0,28).padEnd(29)} ${r.slug}`);
