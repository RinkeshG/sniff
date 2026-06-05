// Warm the deterministic analysis into the Sniff pet-parent voice. The LLM here
// only rewrites prose: the verdict label and every reason's status are fixed
// inputs it cannot change. Its output is then LINTED against the computed facts;
// if it asserts anything unsupported, we throw the voice away and keep the plain
// (already-correct) deterministic copy. Correctness never depends on this layer.

import { callClaude, extractJson } from './llm.js';
import { MARKETING_CLAIM_RE } from './constants.js';

function buildPrompt(meta, c, skeleton) {
  const facts = {
    product: `${meta.brand || ''} ${meta.title || ''}`.trim(),
    category: c.category,
    firstIngredient: c.firstIngredient,
    proteinDM: c.proteinDM,
    carbs: c.carbsUnreliable ? null : c.carbs,
    grainFree: c.grainFree,
    taurineDisclosed: c.taurineDisclosed,
    verdict: skeleton.verdict.label,
  };
  return `You are Sniff, talking to a cat parent in India like a knowledgeable friend. Rewrite the analysis below in a warm, plain, direct voice. Keep it honest.

HARD RULES:
- Do NOT change the verdict. It is fixed: "${skeleton.verdict.label}".
- State ONLY claims supported by these facts. Do not call it grain-free unless grainFree is true. Do not call it high-protein unless proteinDM is 40 or more. Never say "complete", "balanced", "natural", "premium", or "vet-recommended".
- Do not invent any percentage. Only use numbers from the facts.
- No em-dashes. Plain words. No lecturing.

FACTS: ${JSON.stringify(facts)}

Rewrite these ${skeleton.reasons.length} findings in the same order (keep the meaning, just warmer):
${skeleton.reasons.map((r, i) => `${i + 1}. [${r.status}] ${r.q}: ${r.a}`).join('\n')}

Return ONLY this JSON:
{
  "summary": "2-3 sentences, the honest take",
  "tag": "short qualifier, max 4 words",
  "parentTake": "3-4 sentences, like texting a friend who asked should I feed this",
  "action": "1-2 sentences, the concrete next step",
  "note": "1 sentence on the level of concern",
  "fitsIf": ["short phrase", "short phrase"],
  "doesntFitIf": ["short phrase", "short phrase"],
  "reasons": [${skeleton.reasons.map(() => '{ "q": "short", "a": "1-2 sentences" }').join(', ')}]
}`;
}

const allowedPercents = (c) =>
  [c.proteinDM, c.proteinAsFed, c.carbsUnreliable ? null : c.carbs, c.taurinePct, c.caP]
    .filter((n) => n != null);

function gatherText(v) {
  const parts = [v.summary, v.tag, v.parentTake, v.action, v.note];
  (v.fitsIf || []).forEach((s) => parts.push(s));
  (v.doesntFitIf || []).forEach((s) => parts.push(s));
  (v.reasons || []).forEach((r) => { parts.push(r.q); parts.push(r.a); });
  return parts.filter(Boolean).join('  ');
}

// Returns { ok, reason }. ok=false means discard the voice.
export function lintVoice(v, c, skeleton) {
  if (!v || typeof v !== 'object') return { ok: false, reason: 'no object' };
  if (!Array.isArray(v.reasons) || v.reasons.length !== skeleton.reasons.length) return { ok: false, reason: 'reasons length' };
  const text = gatherText(v);
  const low = text.toLowerCase();

  // Unsupported marketing claims.
  if (/\bgrain[-\s]?free\b/.test(low) && c.grainFree !== true) return { ok: false, reason: 'unbacked grain-free' };
  if (/\bhigh[-\s]?protein\b/.test(low) && !(c.proteinDM != null && c.proteinDM >= 40)) return { ok: false, reason: 'unbacked high-protein' };
  if (/\bnamed meat\b/.test(low) && c.meatFirst !== true) return { ok: false, reason: 'unbacked named-meat' };
  if (/\b(complete|balanced|natural|holistic|human[-\s]?grade|vet[-\s]?recommended|no\s+fillers)\b/.test(low)) return { ok: false, reason: 'forbidden marketing claim' };

  // No fabricated percentages.
  const allowed = allowedPercents(c);
  const pcts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => parseFloat(m[1]));
  for (const p of pcts) {
    if (!allowed.some((a) => Math.abs(a - p) <= 0.5)) return { ok: false, reason: `fabricated percent ${p}` };
  }
  return { ok: true };
}

export async function voiceOver(meta, computed, skeleton, opts = {}) {
  let text;
  try {
    text = await callClaude(buildPrompt(meta, computed, skeleton), { maxTokens: 1024, temperature: 0.4, ...opts });
  } catch { return null; }
  const v = extractJson(text);
  const lint = lintVoice(v, computed, skeleton);
  if (!lint.ok) return null;
  return v;
}
