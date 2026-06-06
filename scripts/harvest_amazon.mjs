// Amazon harvester: for each unverified product, find its Amazon listing/variant
// (Apify), OCR the pack-back image for ingredients + guaranteed analysis, run the
// FULL pipeline + identity gate, and emit verified rows. Honest by construction:
// values are OCR'd from the real pack and validated verbatim; the gate refuses any
// label that doesn't fit the product (brand/form/species/life-stage/flavour).
//
// Usage: node scripts/harvest_amazon.mjs <brandFilterSubstr|all> [maxBrandsPerApifyRun]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { parseLabel } from './lib/parse.js';
import { validateFacts } from './lib/validate.js';
import { compute } from './lib/compute.js';
import { score, RUBRIC_VERSION } from './lib/rubric.js';
import { assemble } from './lib/schema.js';
import { productIdentity, labelIdentity, identityConflict, consistencyFlags, classifyForm, classifySpecies, classifyLifeStage, brandKey, lifeStageConflict } from './lib/identity.js';

const TOKEN = readFileSync('/tmp/apify_token', 'utf8').trim();
const SB = 'https://hjscicnzlplxpgxzvdex.supabase.co';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhqc2NpY256bHBseHBneHp2ZGV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3MjA1MTYsImV4cCI6MjA5NTI5NjUxNn0.bX0G5HGcKwnx9wCNt2O6EJxwUYxhcuxtELTXes7X294';
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36' };
const OCR = 'scripts/bin/ocrtool';
const FILTER = (process.argv[2] || 'all').toLowerCase();
const BRANDS_PER_RUN = parseInt(process.argv[3] || '8', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deMojibake = (s) => String(s).replace(/[^\x09\x0A\x20-\x7E]+/g, ' ').replace(/\s{2,}/g, ' ').replace(/\s+([,.)])/g, '$1').trim();

async function getUnverified() {
  let all = [], from = 0;
  for (;;) {
    const r = await fetch(`${SB}/rest/v1/products?select=slug,brand,title,category,life_stage&data_completeness=eq.none&order=slug&offset=${from}&limit=1000`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    const rows = await r.json(); all = all.concat(rows); if (rows.length < 1000) break; from += 1000;
  }
  return all;
}

async function apifySearch(searchUrls) {
  const input = { categoryOrProductUrls: searchUrls.map((u) => ({ url: u })), maxItemsPerStartUrl: 40, maxSearchPagesPerStartUrl: 1, scrapeProductDetails: true };
  const r = await fetch(`https://api.apify.com/v2/acts/junglee~Amazon-crawler/run-sync-get-dataset-items?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  if (!r.ok) { console.error('apify err', r.status, (await r.text()).slice(0, 200)); return []; }
  return await r.json();
}

// expand an Amazon product into candidates (the product + each variant), each with images.
function candidatesFrom(items) {
  const out = [];
  for (const p of items || []) {
    const ingText = (p.importantInformation?.items || []).find((i) => /ingredient/i.test(i.title))?.text || '';
    const baseImgs = [...(p.highResolutionImages || []), ...(p.galleryThumbnails || [])];
    out.push({ name: p.title || '', fullTitle: p.title || '', vendor: p.brand || '', images: baseImgs, ingText, url: p.url });
    for (const v of p.variantDetails || []) out.push({ name: `${p.brand || ''} ${v.name || ''}`, fullTitle: `${p.title || ''} ${v.name || ''}`, vendor: p.brand || '', images: [...(v.images || []), ...baseImgs], ingText: '', url: p.url });
  }
  return out;
}
function candIdentity(c) {
  const t = `${c.vendor} ${c.name}`;
  return { brandKey: brandKey(`${c.vendor} ${c.name}`), species: classifySpecies(t), form: classifyForm(t, null), lifeStage: classifyLifeStage(t), flavours: titleFlavours(t) };
}
import { NAMED_MEATS } from './lib/constants.js';
const titleFlavours = (s) => { const t = String(s || '').toLowerCase(); const out = new Set(); for (const m of NAMED_MEATS) if (new RegExp(`\\b${m}\\b`).test(t)) out.add(m); return out; };

// Distinctive descriptor vocabulary: flavours + form + line/topping modifiers.
// Two products are the SAME product only if these match exactly (no extras either way).
const DESC_WORDS = new Set([...NAMED_MEATS,
  'ocean', 'seafood', 'whitefish',
  'gravy', 'jelly', 'loaf', 'pate', 'mousse', 'broth', 'soup', 'chunks', 'chunk', 'fillet', 'fillets', 'filet', 'terrine', 'sauce', 'flakes', 'bisque', 'stew', 'dry', 'crunchy', 'biscuit', 'kibble',
  'nutri', 'premium', 'gold', 'topping', 'katsuobushi', 'goji', 'berry', 'bonito', 'shirasu', 'sasami', 'scallop', 'pumpkin', 'vegetable', 'vegetables', 'carrot', 'cheese', 'tomato', 'aloe', 'quinoa', 'blueberry', 'pomegranate', 'milk', 'maguro',
  'hairball', 'urinary', 'skin', 'coat', 'persian', 'indoor', 'outdoor', 'sterilised', 'sterilized', 'neutered', 'weight', 'renal', 'kitten', 'junior', 'senior', 'mature']);
const descriptors = (text) => new Set((String(text || '').toLowerCase().match(/[a-z]+/g) || []).filter((w) => DESC_WORDS.has(w)));

// EXACT match: brand+form+species+life-stage agree AND the distinctive descriptor
// set is identical (every flavour/form/line token in our title is in the candidate
// and the candidate adds none). This is "the same product", not "same flavour".
function bestCandidate(prod, cands) {
  const pid = productIdentity({ brand: prod.brand, title: prod.title, category: prod.category, type: 'cat', life_stage: prod.life_stage, slug: prod.slug });
  const pd = descriptors(prod.title);
  if (pd.size === 0) return null; // no distinctive descriptors -> cannot prove an exact match
  let best = null;
  for (const c of cands) {
    const cid = candIdentity(c);
    if (!pid.brandKey || pid.brandKey !== cid.brandKey) continue;
    if (pid.species !== 'unknown' && cid.species !== 'unknown' && pid.species !== cid.species) continue;
    if (pid.form !== 'unknown' && cid.form !== 'unknown' && pid.form !== cid.form) continue;
    if (lifeStageConflict(pid.lifeStage, cid.lifeStage)) continue;
    const cd = descriptors(c.fullTitle);
    let exact = true;
    for (const t of pd) if (!cd.has(t)) { exact = false; break; }   // all our descriptors present
    if (exact) for (const t of cd) if (!pd.has(t)) { exact = false; break; } // and no extra ones
    if (!exact) continue;
    const score = c.images.length;
    if (!best || score > best.score) best = { c, score };
  }
  return best;
}

// OCR a set of image urls, return the combined text of any panel that looks like a label.
function ocrLabelPanels(urls, slug) {
  const dir = `/tmp/amz/${slug}`;
  mkdirSync(dir, { recursive: true });
  const files = [];
  return (async () => {
    for (let i = 0; i < Math.min(urls.length, 10); i++) {
      try { const buf = Buffer.from(await (await fetch(urls[i].split('?')[0], { headers: UA })).arrayBuffer()); if (buf.length < 9000) continue; const f = `${dir}/${i}.img`; writeFileSync(f, buf); files.push(f); } catch {}
    }
    if (!files.length) return [];
    let out = '';
    try { out = execFileSync(OCR, files, { maxBuffer: 256 * 1024 * 1024 }).toString(); } catch { return []; }
    const panels = [];
    for (const chunk of out.split('@@@FILE@@@').slice(1)) {
      const text = chunk.slice(chunk.indexOf('\n') + 1).split('@@@END@@@')[0];
      if (/ingredient/i.test(text) || (/protein/i.test(text) && /(moisture|fibre|fiber|fat)/i.test(text))) panels.push(text);
    }
    return panels;
  })();
}

// deterministic label extraction from OCR text (ingredients line + GA whole-text scan)
function extractLabel(text) {
  const flat = text.replace(/\r/g, '');
  const ingM = flat.match(/ingredients?\s*:?\s*([A-Za-z][^\n]*(?:,[^\n]*){1,})/i);
  const ingredientsText = ingM ? deMojibake(ingM[1]).replace(/\.$/, '') : '';
  // normalize "%30,00" / "30,00%" / "%9" -> "30.00%" / "9%" so the GA regexes match
  const norm = flat.replace(/%\s*(\d{1,2})[.,](\d{1,2})/g, '$1.$2%').replace(/%\s*(\d{1,2})(?![\d.,%])/g, '$1%').replace(/(\d{1,2}),(\d{1,2})\s*%/g, '$1.$2%');
  const g = (re) => { const m = norm.match(re); return m ? parseFloat(m[1]) : null; };
  const ga = {
    protein: g(/protein[^%]{0,28}?(\d{1,2}(?:\.\d+)?)\s*%/i),
    fat: g(/\bfat\b[^%]{0,28}?(\d{1,2}(?:\.\d+)?)\s*%/i),
    fibre: g(/fib(?:re|er)[^%]{0,28}?(\d{1,2}(?:\.\d+)?)\s*%/i),
    moisture: g(/moisture[^%]{0,28}?(\d{1,2}(?:\.\d+)?)\s*%/i),
    ash: g(/\bash\b[^%]{0,28}?(\d{1,2}(?:\.\d+)?)\s*%/i),
    taurineListed: /taurine/i.test(flat),
  };
  return { ingredientsText, ga, rawForValidate: deMojibake(flat) };
}

async function main() {
  let products = await getUnverified();
  if (FILTER !== 'all') products = products.filter((p) => (p.brand || '').toLowerCase().includes(FILTER));
  // group by brandKey
  const groups = new Map();
  for (const p of products) { const bk = brandKey(p.brand) || (p.brand || '').toLowerCase().split('·')[0].trim(); if (!groups.has(bk)) groups.set(bk, { display: (p.brand || '').split('·')[0].trim(), prods: [] }); groups.get(bk).prods.push(p); }
  const brandKeys = [...groups.keys()];
  console.error(`products: ${products.length} | brands: ${brandKeys.length} | filter: ${FILTER}`);

  const verified = [], skipped = [];
  for (let i = 0; i < brandKeys.length; i += BRANDS_PER_RUN) {
    const batch = brandKeys.slice(i, i + BRANDS_PER_RUN);
    const searchUrls = batch.map((bk) => `https://www.amazon.in/s?k=${encodeURIComponent(groups.get(bk).display + ' cat food')}`);
    console.error(`\n[apify] brands ${i + 1}-${i + batch.length}/${brandKeys.length}: ${batch.map((b) => groups.get(b).display).join(', ')}`);
    const items = await apifySearch(searchUrls);
    const cands = candidatesFrom(items);
    console.error(`  amazon candidates: ${cands.length}`);
    for (const bk of batch) {
      const brandCands = cands.filter((c) => brandKey(`${c.vendor} ${c.name}`) === bk);
      for (const prod of groups.get(bk).prods) {
        const m = bestCandidate(prod, brandCands.length ? brandCands : cands);
        if (!m) { skipped.push({ slug: prod.slug, why: 'no Amazon match' }); continue; }
        const panels = await ocrLabelPanels(m.c.images, prod.slug);
        await sleep(150);
        if (!panels.length) { skipped.push({ slug: prod.slug, why: 'matched, no label panel in images', url: m.c.url }); continue; }
        // The OCR'd label MUST contain every SPECIFIC flavour named in our title
        // (tuna+salmon product must show tuna AND salmon), else this pack belongs
        // to a different variant. Generic "fish" is exempt. This is the hard guard
        // against cross-flavour contamination from a loose Amazon match.
        const prodId = productIdentity({ brand: prod.brand, title: prod.title, category: prod.category, type: 'cat', life_stage: prod.life_stage, slug: prod.slug });
        const reqFlav = [...prodId.flavours].filter((f) => f !== 'fish');
        // pick the panel that yields the most complete facts
        let bestRow = null;
        for (const panel of panels) {
          const ex = extractLabel(panel);
          const ingSrc = ex.ingredientsText || (m.c.ingText && m.c.ingText.split(',').length >= 3 ? m.c.ingText : '');
          if (!ingSrc) continue;
          const ingLow = ingSrc.toLowerCase();
          if (reqFlav.length && reqFlav.some((f) => !ingLow.includes(f))) continue; // a title flavour is missing from this label -> wrong pack
          const meta = { brand: prod.brand, title: prod.title, productType: prod.category, lifeStage: prod.life_stage, slug: prod.slug };
          const parsed = parseLabel({ ingredientsText: ingSrc, gaText: ex.rawForValidate });
          // override GA with our OCR scan (more robust than line parse)
          parsed.ga = { ...parsed.ga, protein: ex.ga.protein, fat: ex.ga.fat, fibre: ex.ga.fibre, moisture: ex.ga.moisture, ash: ex.ga.ash, taurineListed: ex.ga.taurineListed };
          const val = validateFacts(parsed, { ingredientsText: ingSrc, gaText: ex.rawForValidate });
          if (!val.firstIngredientValid) continue;
          val.facts.taurineListed = ex.ga.taurineListed;
          const computed = compute(val.facts, meta);
          const labId = labelIdentity({ facts: val.facts, sourceUrl: m.c.url, firstIngredient: computed.firstIngredient });
          const conflict = identityConflict(prodId, labId, val.facts.ingredientsText || '');
          const cf = consistencyFlags({ facts: val.facts, prodForm: prodId.form, harvesterCompleteness: (val.facts.ga.protein != null && val.facts.ga.moisture != null) ? 'full' : 'partial' });
          if (conflict.hard.length || cf.gaImplausible) continue;
          const sk = score(computed);
          const analysis = assemble(sk, null, { source: 'amazon-pack', sourceUrl: m.c.url, checkedAt: null, completeness: cf.completeness, rubricVersion: RUBRIC_VERSION, productForm: prodId.form });
          if (conflict.soft.length) analysis.reviewReason = conflict.soft.join('; ');
          const row = { slug: prod.slug, analysis, extracted_facts: val.facts, data_completeness: cf.completeness, confidence: cf.completeness === 'full' ? 1 : 0.65, needs_review: conflict.soft.length > 0, sourceUrl: m.c.url, sourceTier: 'amazon-pack', verdict: sk.verdict.label, firstIng: computed.firstIngredient, hasGA: val.facts.ga.protein != null };
          if (!bestRow || (row.hasGA && !bestRow.hasGA)) bestRow = row;
        }
        if (bestRow) { verified.push(bestRow); console.error(`  + ${bestRow.data_completeness.padEnd(7)} ${bestRow.verdict.padEnd(16)} ${prod.slug} [${bestRow.firstIng}]`); }
        else skipped.push({ slug: prod.slug, why: 'label found but unparseable/failed gate', url: m.c.url });
      }
    }
    writeFileSync('/tmp/amazon_harvest.json', JSON.stringify({ verified, skipped }));
  }
  console.error(`\n=== DONE: verified ${verified.length} / ${products.length} | skipped ${skipped.length} ===`);
  writeFileSync('/tmp/amazon_harvest.json', JSON.stringify({ verified, skipped }));
}
main();
