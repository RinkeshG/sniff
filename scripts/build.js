#!/usr/bin/env node
/**
 * Stage 2: build analyses offline from harvested labels. Deterministic parse ->
 * validate -> compute -> score -> assemble (plain voice). NO LLM, NO keys.
 *
 * Writes scripts/data/analyses.json (ready to load into analysis_v2) and
 * scripts/data/review.json (labels the parser could not read cleanly, or that
 * need a human/voice pass). Prints a coverage report.
 *
 * Run: ~/.nvm/versions/node/v22.17.0/bin/node scripts/build.js
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildAnalysis } from './lib/pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, 'data');
const labels = JSON.parse(readFileSync(resolve(DATA, 'labels.json'), 'utf8'));

const out = Object.values(labels).map(buildAnalysis);
writeFileSync(resolve(DATA, 'analyses.json'), JSON.stringify(out, null, 2));

const review = out.filter((o) => o.needs_review || o.parseConfidence === 'low');
writeFileSync(resolve(DATA, 'review.json'), JSON.stringify(review, null, 2));

const t = { full: 0, partial: 0, none: 0, confident: 0, review: review.length };
const verdicts = {};
for (const o of out) {
  t[o.data_completeness]++;
  if (o.confidence >= 0.65) t.confident++;
  verdicts[o.verdict] = (verdicts[o.verdict] || 0) + 1;
}
console.log(`built ${out.length} analyses`);
console.log(`completeness  full:${t.full}  partial:${t.partial}  none:${t.none}`);
console.log(`confident(>=.65):${t.confident}  needs-review:${t.review}`);
console.log('verdicts:', verdicts);
