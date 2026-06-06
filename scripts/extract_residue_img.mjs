#!/usr/bin/env node
/**
 * Residue extractor, IMAGE path — for products whose label is only in a pack
 * photo on a retailer page (e.g. Me-O on Amazon). Firecrawl finds the page +
 * gives rawHtml -> pull pack-image URLs -> OCR locally (ocrtool, free) -> ONE
 * Sonnet call -> ground -> gate. All off the main context / Max quota.
 *
 * Run: ANTHROPIC_API_KEY=$(cat /tmp/anthropic_key) node scripts/extract_residue_img.mjs /tmp/img_batch1.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { callClaude, extractJson } from './lib/llm.js';
import { buildAnalysis } from './lib/pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OCRTOOL = resolve(__dirname, 'bin/ocrtool');
const MODEL = 'claude-sonnet-4-5-20250929';
const FC = readFileSync('/tmp/firecrawl_key', 'utf8').trim();
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };
const slugs = JSON.parse(readFileSync(process.argv[2] || '/tmp/img_batch1.json', 'utf8'));
const NOW = new Date().toISOString();
const baseBrand = (b) => String(b || '').split('·')[0].trim();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9% ]/g, ' ').replace(/\s+/g, ' ').trim();

async function fcSearch(q) {
  try { const r = await fetch('https://api.firecrawl.dev/v1/search', { method: 'POST', headers: { Authorization: `Bearer ${FC}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, limit: 8 }) });
    return ((await r.json()).data || []).map((x) => x.url).filter(Boolean); } catch { return []; }
}
async function fcRaw(url) {
  try { const r = await fetch('https://api.firecrawl.dev/v1/scrape', { method: 'POST', headers: { Authorization: `Bearer ${FC}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ url, formats: ['rawHtml', 'markdown'], onlyMainContent: false, timeout: 30000 }) });
    const j = await r.json(); return { html: (j.data && j.data.rawHtml) || '', md: (j.data && j.data.markdown) || '' }; } catch { return { html: '', md: '' }; }
}
// hi-res product gallery images. Amazon stores the real pack photos as
// "hiRes":"..." (and "large":"...") inside a JS blob, with slashes escaped.
const unesc = (u) => u.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
function imageUrls(html) {
  const out = [];
  for (const m of html.matchAll(/"hiRes":"(https:[^"]+?media-amazon[^"]+?\.(?:jpg|jpeg|png))"/g)) out.push(unesc(m[1]));
  if (out.length < 2) for (const m of html.matchAll(/"large":"(https:[^"]+?media-amazon[^"]+?\.(?:jpg|jpeg|png))"/g)) out.push(unesc(m[1]));
  // shopify / other retailer product CDNs as fallback
  for (const m of html.matchAll(/https:\/\/[^"' )\\]+?\.(?:jpg|jpeg|png|webp)/g)) { const u = m[0]; if (/cdn\.shopify|\/cdn\/|productimages|product-images/i.test(u) && !/sprite|icon|logo|placeholder/i.test(u)) out.push(u); }
  return [...new Set(out)].slice(0, 10);
}
async function ocrImages(urls, dir) {
  mkdirSync(dir, { recursive: true }); const files = [];
  for (let i = 0; i < urls.length; i++) { try { const b = Buffer.from(await (await fetch(urls[i], { headers: UA })).arrayBuffer()); if (b.length < 9000) continue; const f = `${dir}/${i}.img`; writeFileSync(f, b); files.push(f); } catch {} }
  if (!files.length) return '';
  try { return execFileSync(OCRTOOL, files, { maxBuffer: 256 * 1024 * 1024 }).toString().replace(/@@@FILE@@@[^\n]*\n/g, ' ').replace(/@@@END@@@/g, ' '); } catch { return ''; }
}
function windows(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const re = /(ingredient|composition|guaranteed analysis|crude protein|kandungan)/ig; const out = []; let m;
  while ((m = re.exec(t)) && out.length < 8) { out.push(t.slice(Math.max(0, m.index - 90), m.index + 650)); re.lastIndex = m.index + 650; }
  return out.join('  ...  ').slice(0, 6500);
}
const PROMPT = (b, c) => `Extract the REAL ingredient list and guaranteed analysis for this cat product from the text below (OCR of pack photos + page text).
Product: brand="${baseBrand(b.brand)}", name="${b.title}", form="${b.category}".
Rules: use ONLY text below; fix obvious OCR typos only if unambiguous; quote ingredient names IN ORDER; ignore marketing; trust the actual list over the flavour name; for a TREAT with no list you may use the stated protein. Return STRICT JSON, nulls if absent:
{"ingredients":["..."],"gaText":"... or null","sourceHint":"url","leadIngredient":"... or null"}
TEXT:
"""
${c}
"""`;
const SQLV = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const J = (o) => `$J$${JSON.stringify(o)}$J$::jsonb`;
function toSQL(slug, r, url) { const a = J(r.analysis);
  return `UPDATE products SET analysis=${a}, analysis_v2=${a}, extracted_facts=${r.extracted_facts ? J(r.extracted_facts) : 'NULL'}, data_completeness='${r.data_completeness}', confidence=${r.confidence}, needs_review=${r.needs_review}, source_url=${SQLV(url)}, source_tier='amazon-pack', source_fetched_at='${NOW}', rubric_version=${SQLV(r.analysis.rubricVersion)} WHERE slug='${slug}';`; }

const sql = [], report = [];
for (const slug of slugs) {
  if (!existsSync(`/tmp/evidence/${slug}.json`)) { report.push({ slug, status: 'no-bundle' }); continue; }
  const b = JSON.parse(readFileSync(`/tmp/evidence/${slug}.json`, 'utf8'));
  const localText = (b.sources || []).map((s) => `${s.description} ${s.packImageText}`).join(' ');
  const urls = await fcSearch(`${baseBrand(b.brand)} ${b.title} cat food ingredients`);
  // prefer amazon, then other retailers with images
  const ranked = urls.sort((a, c) => (/(amazon\.)/i.test(c) ? 1 : 0) - (/(amazon\.)/i.test(a) ? 1 : 0));
  let ocrText = '', usedUrl = null;
  for (const u of ranked.slice(0, 3)) {
    const { html, md } = await fcRaw(u);
    const imgs = imageUrls(html);
    const ocr = await ocrImages(imgs, `/tmp/amz/${slug}`);
    if (ocr && /ingredient|kandungan|crude protein/i.test(ocr)) { ocrText += `\n[${u}]\n${ocr}`; usedUrl = usedUrl || u; break; }
    if (md && /ingredient|crude protein/i.test(md)) { ocrText += `\n[${u}]\n${md}`; usedUrl = usedUrl || u; }
  }
  const combined = windows(`${localText} ${ocrText}`);
  let parsed = null;
  try { parsed = extractJson(await callClaude(PROMPT(b, combined), { model: MODEL, maxTokens: 800, temperature: 0 })); }
  catch (e) { report.push({ slug, status: 'llm-err' }); continue; }
  const ings = (parsed && Array.isArray(parsed.ingredients)) ? parsed.ingredients : [];
  const groundText = norm(`${localText} ${ocrText}`);
  const grounded = ings.filter((n) => { const x = norm(String(n).split('(')[0]); return x.length >= 2 && groundText.includes(x); });
  const ingredientsText = grounded.length ? grounded.join(', ') : null;
  let gaText = parsed && parsed.gaText ? parsed.gaText : null;
  if (gaText) { const gn = gaText.match(/\d+(?:\.\d+)?/g) || []; const present = gn.filter((x) => groundText.includes(String(x))); if (!gn.length || present.length < Math.ceil(gn.length / 2)) gaText = null; }
  if (!ingredientsText) { report.push({ slug, status: 'no-grounded', gave: ings.length, url: usedUrl }); continue; }
  const l = { slug, brand: b.brand, title: b.title, category: b.category, life_stage: b.life_stage, type: b.type, sourceTier: 'amazon-pack', sourceUrl: usedUrl, fetchedAt: NOW, completeness: ingredientsText && gaText ? 'full' : 'partial', ingredientsText, gaText, identityOk: true, multiProduct: false };
  const r = buildAnalysis(l);
  report.push({ slug, status: 'ok', verdict: r.verdict, completeness: r.data_completeness, first: r.firstIngredient, url: usedUrl });
  if (r.verdict !== 'Not verified yet') sql.push(toSQL(slug, r, usedUrl));
}
writeFileSync('/tmp/residue_img.sql', sql.join('\n') + (sql.length ? '\n' : ''));
writeFileSync('/tmp/residue_img_report.json', JSON.stringify(report, null, 2));
const ok = report.filter((r) => r.status === 'ok' && r.verdict !== 'Not verified yet');
console.log(`batch ${slugs.length} | verified ${ok.length} | SQL ${sql.length}`);
for (const r of report) console.log(`  ${(r.verdict || r.status).padEnd(18)} ${(r.first || '').slice(0, 30).padEnd(31)} ${r.slug}`);
