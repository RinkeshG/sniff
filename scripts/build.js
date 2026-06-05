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
import { parseLabel } from './lib/parse.js';
import { validateFacts } from './lib/validate.js';
import { compute } from './lib/compute.js';
import { score, RUBRIC_VERSION } from './lib/rubric.js';
import { assemble, abstainAnalysis } from './lib/schema.js';
import { productIdentity, labelIdentity, identityConflict, consistencyFlags } from './lib/identity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, 'data');
const labels = JSON.parse(readFileSync(resolve(DATA, 'labels.json'), 'utf8'));

const STRONG = new Set(['Strong choice', 'Good enough']);

function buildOne(l) {
  const meta = { brand: l.brand, title: l.title, productType: l.category, lifeStage: l.life_stage, slug: l.slug };
  const provenance = { source: l.sourceTier || 'supertails', sourceUrl: l.sourceUrl, checkedAt: l.fetchedAt, completeness: l.completeness, rubricVersion: RUBRIC_VERSION };

  if (l.completeness === 'none') {
    return { slug: l.slug, brand: l.brand, title: l.title, analysis: abstainAnalysis(meta, provenance), extracted_facts: null, data_completeness: 'none', confidence: 0, needs_review: false, parseConfidence: 'ok', sourceUrl: l.sourceUrl, sourceTier: l.sourceTier, fetchedAt: l.fetchedAt };
  }

  const parsed = parseLabel({ ingredientsText: l.ingredientsText, gaText: l.gaText });
  const val = validateFacts(parsed, { ingredientsText: l.ingredientsText || '', gaText: l.gaText || '' });
  const untrustworthy = !!l.ingredientsText && !val.firstIngredientValid;

  let analysis, computed = null, dataCompleteness, confidence, needsReview;
  if (untrustworthy || parsed.parseConfidence === 'low') {
    analysis = abstainAnalysis(meta, provenance);
    dataCompleteness = 'none'; confidence = 0; needsReview = true;
  } else {
    computed = compute(val.facts, meta);

    // ── Identity & consistency gate ───────────────────────────────────────
    // Prove the label belongs to THIS product (right brand/form/species/life-
    // stage/flavour) and that the numbers are internally plausible. A hard
    // conflict means the label cannot be this product's -> abstain, never guess.
    const idMeta = { brand: l.brand, title: l.title, category: l.category, type: l.type || l.species || 'cat', life_stage: l.life_stage, slug: l.slug };
    const prodId = productIdentity(idMeta);
    const labId = labelIdentity({ facts: val.facts, sourceUrl: l.sourceUrl, title: l.title, firstIngredient: computed.firstIngredient });
    const conflict = identityConflict(prodId, labId, val.facts.ingredientsText || '');

    const cf = consistencyFlags({ facts: val.facts, prodForm: prodId.form, harvesterCompleteness: l.completeness });
    const varietyTitle = /\b(variety|assorted|combo|multi[-\s]?pack|pack of|trio|mixed)\b/i.test(l.title || '');

    if (conflict.hard.length || cf.gaImplausible) {
      const reason = conflict.hard.length ? conflict.hard : [`guaranteed analysis sums to ${Math.round(cf.gaSum)}% (implausible)`];
      analysis = abstainAnalysis(meta, { ...provenance, conflict: reason });
      analysis.reviewReason = reason.join('; ');
      dataCompleteness = 'none'; confidence = 0; needsReview = true;
    } else {
      const sk = score(computed);
      analysis = assemble(sk, null, { ...provenance, productForm: prodId.form }); // plain voice; warmed later by the voice pass
      const label = sk.verdict.label;
      const full = cf.completeness === 'full';
      const confident = val.firstIngredientValid && label !== 'Not transparent enough' && l.identityOk && !l.multiProduct && (!STRONG.has(label) || full);
      dataCompleteness = cf.completeness;
      confidence = confident ? (full ? 1 : 0.65) : 0.3;
      needsReview = l.multiProduct || val.errors.length > 0 || conflict.soft.length > 0 || varietyTitle;
      if (conflict.soft.length) analysis.reviewReason = conflict.soft.join('; ');
    }
  }

  return {
    slug: l.slug, brand: l.brand, title: l.title,
    analysis, extracted_facts: val.facts || null,
    data_completeness: dataCompleteness, confidence, needs_review: needsReview,
    parseConfidence: parsed.parseConfidence,
    verdict: analysis.verdict.label, firstIngredient: computed ? computed.firstIngredient : null,
    proteinDM: computed ? computed.proteinDM : null, carbs: computed ? computed.carbs : null, grainFree: computed ? computed.grainFree : null,
    sourceUrl: l.sourceUrl, sourceTier: l.sourceTier, fetchedAt: l.fetchedAt,
  };
}

const out = Object.values(labels).map(buildOne);
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
