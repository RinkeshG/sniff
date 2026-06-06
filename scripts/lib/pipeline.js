// Single source of truth for turning a harvested label into a published analysis.
//
// This is the deterministic parse -> validate -> identity/consistency gate ->
// assemble flow. build.js (bulk) and the per-brand harvesters (e.g.
// harvest_goofytails.mjs) BOTH call buildAnalysis(l) so the gate can never drift
// between the batch build and a one-off verification. NO LLM, NO keys.
//
// Input `l` (one harvested label) shape:
//   { slug, brand, title, category, life_stage, type|species,
//     sourceTier, sourceUrl, fetchedAt, completeness,
//     ingredientsText, gaText, identityOk, multiProduct }

import { parseLabel } from './parse.js';
import { validateFacts } from './validate.js';
import { compute } from './compute.js';
import { score, RUBRIC_VERSION } from './rubric.js';
import { assemble, abstainAnalysis } from './schema.js';
import { productIdentity, labelIdentity, identityConflict, consistencyFlags } from './identity.js';

const STRONG = new Set(['Strong choice', 'Good enough']);

export function buildAnalysis(l) {
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
