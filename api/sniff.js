// On-demand analysis. Reworked to be label-backed: we resolve the query to a
// real product, fetch its actual label (Supertails .json), and run the SAME
// gated pipeline as the bulk ingester. If we cannot find a real label, we say
// so (honest "not verified") instead of analyzing the product name. Fresh
// results are returned for display and queued as needs_review, never persisted
// as a confident verdict.

import { fetchLabel } from '../scripts/lib/source.js';
import { extractFacts } from '../scripts/lib/extract.js';
import { validateFacts } from '../scripts/lib/validate.js';
import { compute } from '../scripts/lib/compute.js';
import { score, RUBRIC_VERSION } from '../scripts/lib/rubric.js';
import { voiceOver } from '../scripts/lib/voice.js';
import { assemble, abstainAnalysis } from '../scripts/lib/schema.js';

export const config = { maxDuration: 30 };

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hjscicnzlplxpgxzvdex.supabase.co';
const READ_KEY = process.env.SUPABASE_KEY || 'sb_publishable_q8CsjF6ub7apLI79mzsc2Q_Hg7-T2IA';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const enc = encodeURIComponent;
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: READ_KEY, Authorization: `Bearer ${READ_KEY}` } });
  if (!r.ok) return [];
  return r.json();
}

async function findProduct(query) {
  const q = query.trim();
  const pCols = 'slug,brand,title,image_url,product_link,category,life_stage,type,analysis,analysis_v2,rubric_version';
  let rows = await sbGet(`products?slug=eq.${enc(slugify(q))}&select=${pCols}&limit=1`);
  if (!rows.length) rows = await sbGet(`products?search_text=ilike.*${enc(q)}*&select=${pCols}&limit=1`);
  if (rows.length) return { kind: 'product', row: rows[0] };
  const cat = await sbGet(`shopify_catalog?title=ilike.*${enc(q)}*&select=handle,title,vendor,species,image_url,product_link&limit=1`);
  if (cat.length) return { kind: 'catalog', row: cat[0] };
  return null;
}

function catResponse(identity, analysis) {
  // Flat object: frontend reads it both as the product (brand/title/etc) and as
  // the analysis (verdict/metrics/...). type is forced to 'cat'.
  return { type: 'cat', slug: identity.slug, brand: identity.brand, title: identity.title, image_url: identity.image_url, product_link: identity.product_link, category: identity.category, life_stage: identity.life_stage, ...analysis };
}

async function queue(identity, analysis, completeness, confidence, facts, source) {
  if (!SERVICE_KEY || identity.kind !== 'product') return; // non-persist by default
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/products?slug=eq.${enc(identity.slug)}`, {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        analysis_v2: analysis, extracted_facts: facts || null, data_completeness: completeness,
        confidence, source_url: source.sourceUrl, source_tier: source.sourceTier,
        source_fetched_at: source.fetchedAt, rubric_version: RUBRIC_VERSION, needs_review: true,
      }),
    });
  } catch { /* non-blocking */ }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { query } = req.body || {};
  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return res.status(400).json({ error: 'Please enter a product name' });
  }
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Server configuration error' });

  try {
    const found = await findProduct(query);
    if (!found) return res.status(200).json({ type: 'not_found', query });

    let identity;
    if (found.kind === 'product') {
      const r = found.row;
      if (r.type === 'dog') return res.status(200).json({ type: 'dog', brand: r.brand, title: r.title });
      // Already label-backed in the DB: serve it.
      if (r.rubric_version && (r.analysis_v2 || r.analysis)) {
        return res.status(200).json(catResponse(r, r.analysis_v2 || r.analysis));
      }
      identity = { kind: 'product', slug: r.slug, brand: r.brand, title: r.title, image_url: r.image_url, product_link: r.product_link, category: r.category, life_stage: r.life_stage };
    } else {
      const r = found.row;
      if (r.species === 'dog') return res.status(200).json({ type: 'dog', brand: r.vendor, title: r.title });
      if (r.species && r.species !== 'cat') return res.status(200).json({ type: 'not_food', query });
      identity = { kind: 'catalog', slug: r.handle, brand: r.vendor, title: r.title, image_url: r.image_url, product_link: r.product_link, category: null, life_stage: null };
    }

    const source = await fetchLabel({ slug: identity.slug, brand: identity.brand, title: identity.title, product_link: identity.product_link });
    const provenance = { source: source.sourceTier, sourceUrl: source.sourceUrl, checkedAt: source.fetchedAt, completeness: source.completeness, rubricVersion: RUBRIC_VERSION };
    const meta = { brand: identity.brand, title: identity.title, productType: identity.category, lifeStage: identity.life_stage, slug: identity.slug };

    if (source.completeness === 'none') {
      const a = abstainAnalysis(meta, provenance);
      await queue(identity, a, 'none', 0, null, source);
      return res.status(200).json(catResponse(identity, a));
    }

    const raw = await extractFacts({ ingredientsText: source.ingredientsText, gaText: source.gaText });
    const val = validateFacts(raw, { ingredientsText: source.ingredientsText || '', gaText: source.gaText || '' });
    const untrustworthy = !!source.ingredientsText && !val.firstIngredientValid;

    if (untrustworthy) {
      const a = abstainAnalysis(meta, provenance);
      await queue(identity, a, 'none', 0, val.facts, source);
      return res.status(200).json(catResponse(identity, a));
    }

    const computed = compute(val.facts, meta);
    const skeleton = score(computed);
    const v = await voiceOver(meta, computed, skeleton);
    const analysis = assemble(skeleton, v, provenance);
    const completeness = source.completeness;
    await queue(identity, analysis, completeness, completeness === 'full' ? 0.65 : 0.5, val.facts, source);
    return res.status(200).json(catResponse(identity, analysis));
  } catch (err) {
    console.error('Sniff API error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}
