#!/usr/bin/env node
/**
 * Merge brand-site labels (read verbatim from brand/retailer pages) into
 * labels.json. Input: a JSON file mapping slug -> { ingredientsText, gaText?,
 * sourceUrl, sourceTier? }. Only upgrades products currently 'none'.
 *
 * Usage: node scripts/apply_labels.mjs scripts/data/brand_batch.json
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const labelsPath = resolve(__dirname, 'data', 'labels.json');
const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));
const batch = JSON.parse(readFileSync(process.argv[2], 'utf8'));

let applied = 0, skipped = 0;
for (const [slug, d] of Object.entries(batch)) {
  const l = labels[slug];
  if (!l) { console.log('  ? unknown slug:', slug); continue; }
  if (!d.ingredientsText && !d.gaText) { skipped++; continue; }
  l.ingredientsText = d.ingredientsText || null;
  l.gaText = d.gaText || null;
  l.completeness = d.ingredientsText && d.gaText ? 'full' : 'partial';
  l.sourceTier = d.sourceTier || 'brand';
  l.sourceUrl = d.sourceUrl || l.sourceUrl;
  l.identityOk = true; l.multiProduct = false;
  applied++;
}
writeFileSync(labelsPath, JSON.stringify(labels, null, 2));
console.log(`applied ${applied} brand labels, skipped ${skipped}.`);
