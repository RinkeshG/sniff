#!/usr/bin/env node
/**
 * Image-OCR harvest (macOS Vision). For products still unverified after the
 * body_html pass, OCR the product gallery, find the photo carrying the real
 * label (pack-back or "Key Ingredients" panel), and extract ingredients + GA.
 * Accurate and scriptable, no API key.
 *
 * Updates scripts/data/labels.json in place (upgrades completeness, sets
 * sourceTier='supertails-image'). Resumable. Run with Node 18+ on macOS.
 *
 * Flags: --limit=N (process only first N), --brand="Sheba"
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, 'data');
const TMP = '/tmp/sniff_ocr';
mkdirSync(TMP, { recursive: true });
const BIN = resolve(__dirname, 'bin', 'ocrtool');
const args = process.argv.slice(2);
const LIMIT = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] || '0', 10);
const BRAND = args.find((a) => a.startsWith('--brand='))?.split('=')[1];
const UA = { 'User-Agent': 'SniffBot/1.0 (+https://sniff.fyi)' };
const MAX_IMAGES = 20;

// Compile the Vision OCR tool if needed.
if (!existsSync(BIN)) {
  mkdirSync(resolve(__dirname, 'bin'), { recursive: true });
  execFileSync('swiftc', ['-O', resolve(__dirname, 'ocr.swift'), '-o', BIN], { stdio: 'inherit' });
}

const labelsPath = resolve(DATA, 'labels.json');
const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));
let todo = Object.values(labels).filter((l) => l.completeness === 'none' && !l.imageChecked
  && /supertails\.com\/products\//.test(l.product_link || ''));
if (BRAND) todo = todo.filter((l) => (l.brand || '').toLowerCase().includes(BRAND.toLowerCase()));
const brandOf = (l) => (l.brand || '').split(' · ')[0];
const freq = {};
todo.forEach((l) => { const b = brandOf(l); freq[b] = (freq[b] || 0) + 1; });
todo.sort((a, b) => freq[brandOf(b)] - freq[brandOf(a)]); // big brands first
if (LIMIT > 0) todo = todo.slice(0, LIMIT);

const handleOf = (link) => (link.match(/\/products\/([^/?#]+)/) || [])[1];
const STOP = /^(guaranteed analysis|nutritional analysis|analytical|nutritional information|feeding|for manufacturing|net quantity|country of origin|imported|manufactured|store|best before|mrp|directions|how to|visit us|for mfg|for pet|registered|consumer care)/i;

function extractLabel(text) {
  const lines = text.split('\n').map((l) => l.replace(/^[\s•*=\-]+/, '').trim()).filter(Boolean);
  let ing = null, ga = null;
  for (let i = 0; i < lines.length; i++) {
    // "Key Ingredients" infographic panel: header then a comma list (no GA).
    const km = lines[i].match(/^key ingredients?\b\s*(.*)$/i);
    if (km) {
      const cand = (km[1] && (km[1].match(/,/g) || []).length >= 2) ? km[1]
        : (lines[i + 1] && (lines[i + 1].match(/,/g) || []).length >= 2) ? lines[i + 1] : null;
      if (cand && (!ing || cand.length > ing.length)) ing = cand.trim();
    }
    const m = lines[i].match(/^(ingredients?|composition)\s*[:\-]\s*(.*)$/i);
    if (m) {
      const buf = m[2] ? [m[2]] : [];
      for (let j = i + 1; j < lines.length; j++) {
        if (STOP.test(lines[j])) break;
        buf.push(lines[j]);
        if (buf.join(' ').length > 700) break;
        if (/[.)]\s*$/.test(lines[j]) && buf.join(' ').length > 25) break;
      }
      const t = buf.join(' ').trim();
      if ((t.match(/,/g) || []).length >= 2 && (!ing || t.length > ing.length)) ing = t;
    }
    if (/(guaranteed analysis|nutritional analysis|analytical constituents|crude protein)/i.test(lines[i])) {
      const buf = [lines[i]];
      for (let j = i + 1; j < lines.length && j < i + 3; j++) {
        if (/%|protein|fat|fib(re|er)|moisture|\bash/i.test(lines[j])) buf.push(lines[j]); else break;
      }
      const t = buf.join(' ');
      if (/\d/.test(t) && (!ga || t.length > ga.length)) ga = t.replace(/^.*?(analysis|constituents)\s*[:\-]?/i, '').trim();
    }
  }
  return { ingredientsText: ing, gaText: ga };
}

async function downloadImages(handle) {
  const j = await (await fetch(`https://supertails.com/products/${handle}.json`, { headers: UA })).json();
  const imgs = (j.product?.images || []).slice(0, MAX_IMAGES);
  const files = [];
  for (let i = 0; i < imgs.length; i++) {
    try {
      const buf = Buffer.from(await (await fetch(imgs[i].src, { headers: UA })).arrayBuffer());
      const f = `${TMP}/${i}.img`; writeFileSync(f, buf); files.push({ f, src: imgs[i].src });
    } catch { /* skip */ }
  }
  return files;
}

function ocrAll(files) {
  if (!files.length) return {};
  const out = execFileSync(BIN, files.map((x) => x.f), { maxBuffer: 128 * 1024 * 1024 }).toString();
  const map = {};
  for (const chunk of out.split('@@@FILE@@@').slice(1)) {
    const nl = chunk.indexOf('\n');
    const path = chunk.slice(0, nl).trim();
    map[path] = chunk.slice(nl + 1).split('@@@END@@@')[0];
  }
  return map;
}

let upgraded = 0, still = 0, n = 0;
for (const l of todo) {
  n++;
  try {
    const files = await downloadImages(handleOf(l.product_link));
    const texts = ocrAll(files);
    let best = null;
    for (const fobj of files) {
      const { ingredientsText, gaText } = extractLabel(texts[fobj.f] || '');
      if (ingredientsText) {
        const sc = ingredientsText.length + (gaText ? 1000 : 0);
        if (!best || sc > best.sc) best = { ingredientsText, gaText, src: fobj.src, sc };
      }
    }
    if (best) {
      l.ingredientsText = best.ingredientsText;
      l.gaText = best.gaText || null;
      l.completeness = best.gaText ? 'full' : 'partial';
      l.sourceTier = 'supertails-image';
      l.sourceUrl = best.src;
      l.identityOk = true; l.multiProduct = false;
      upgraded++;
    } else { still++; }
    l.imageChecked = true;
  } catch (e) { l.imageChecked = true; still++; }
  if (n % 5 === 0) { writeFileSync(labelsPath, JSON.stringify(labels, null, 2)); process.stdout.write(`\r[${n}/${todo.length}] upgraded:${upgraded} still-none:${still}   `); }
}
writeFileSync(labelsPath, JSON.stringify(labels, null, 2));
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\nDONE. upgraded ${upgraded} to a real label, ${still} still none.`);
