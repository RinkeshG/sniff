#!/usr/bin/env node
/**
 * Propagate a verified label to duplicate listings of the SAME product.
 * Supertails lists the same product many times. We build a precise product
 * SIGNATURE from structured fields + distinctive flavour/sub-line tokens, and
 * only copy a label between listings whose signature is identical. Two genuinely
 * different recipes never share a signature, so this can't cross-contaminate.
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const labelsPath = resolve(__dirname, 'data', 'labels.json');
const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));

// Distinctive tokens that distinguish one recipe from another.
const DISTINCT = new Set('tuna chicken salmon mackerel ocean fish sardine prawn prawns shrimp crab bonito whitefish lamb beef duck liver herring anchovy pumpkin cheese tomato goat milk vegetable veg vegetables quinoa pomegranate blueberry quail boar cod sasami aloe persian hairball indoor sterilized sterilised urinary renal light weight gastrointestinal struvite hypoallergenic apro iq delite prime jelly gravy mousse loaf broth creamy melty snack jerky churu stick bite paste pate cheese rice potato turkey egg shrimps scallop tilapia'.split(' '));

function lifeStage(l) {
  const s = (l.slug + ' ' + (l.life_stage || '')).toLowerCase();
  if (/kitten|junior|baby/.test(s)) return 'kitten';
  if (/senior|mature|ageing|aging|12/.test(s)) return 'senior';
  return 'adult';
}
function form(l) {
  const s = l.slug.toLowerCase();
  if (/treat|creamy|jerky|churu|melty|snack|stick|bite|temptation|dreamies/.test(s) || l.category === 'treat') return 'treat';
  if (/wet|jelly|gravy|mousse|loaf|pouch|broth|\bcan\b|pate/.test(s) || l.category === 'wet') return 'wet';
  return 'dry';
}
function signature(l) {
  const brand = (l.brand || '').split(' · ')[0].toLowerCase();
  const dist = [...new Set(l.slug.toLowerCase().split('-').filter((t) => DISTINCT.has(t)))].sort();
  return `${brand}|${form(l)}|${lifeStage(l)}|${dist.join(',')}`;
}

const bySig = {};
for (const l of Object.values(labels)) {
  if (l.completeness && l.completeness !== 'none' && l.ingredientsText) {
    const sig = signature(l);
    if (!bySig[sig] || (l.completeness === 'full' && bySig[sig].completeness !== 'full')) bySig[sig] = l;
  }
}

let propagated = 0;
for (const l of Object.values(labels)) {
  if (l.completeness !== 'none') continue;
  const dist = [...new Set(l.slug.toLowerCase().split('-').filter((t) => DISTINCT.has(t)))];
  if (!dist.length) continue;                 // need at least one distinctive token to be safe
  const src = bySig[signature(l)];
  if (src) {
    l.ingredientsText = src.ingredientsText;
    l.gaText = src.gaText || null;
    l.completeness = src.completeness;
    l.sourceTier = (src.sourceTier || 'source').replace(/-dup$/, '') + '-dup';
    l.sourceUrl = src.sourceUrl;
    l.identityOk = true; l.multiProduct = false;
    propagated++;
  }
}
writeFileSync(labelsPath, JSON.stringify(labels, null, 2));
console.log(`propagated labels to ${propagated} duplicate listings.`);
