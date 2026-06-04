// Turn the accepted label text into structured facts. The LLM is fed ONLY the
// isolated Composition + Analytical-Constituents sections (never the marketing
// body), at temperature 0, and told to return null for anything not literally
// present. Everything it returns is then re-checked by validate.js.

import { callClaude, extractJson } from './llm.js';

function buildPrompt(ingredientsText, gaText) {
  return `You are a precise label-reading function. You are given the INGREDIENTS text and the GUARANTEED ANALYSIS text copied verbatim from a cat food package. Convert them to JSON.

Rules:
- Use ONLY what is literally written below. Do not use any outside knowledge of the brand or product.
- If a value is not present in the text, return null for it. Never infer, round, or invent.
- Ingredients must be in the order written. Keep the original wording of each name. If a percentage is written next to an ingredient, capture it as a number; otherwise pct is null.
- For taurine, capture the value and its unit exactly ("mg/kg" or "percent").
- Return ONLY this JSON, no prose, no markdown:
{
  "ingredients": [{ "name": "string", "pct": number_or_null }],
  "ga": {
    "protein": number_or_null,
    "fat": number_or_null,
    "fibre": number_or_null,
    "moisture": number_or_null,
    "ash": number_or_null,
    "calcium": number_or_null,
    "phosphorus": number_or_null,
    "taurine": { "value": number, "unit": "mg/kg" | "percent" } or null,
    "taurineListed": boolean
  }
}

INGREDIENTS:
"""
${ingredientsText || '(none provided)'}
"""

GUARANTEED ANALYSIS:
"""
${gaText || '(none provided)'}
"""`;
}

export async function extractFacts({ ingredientsText, gaText }, opts = {}) {
  const text = await callClaude(buildPrompt(ingredientsText, gaText), { maxTokens: 1024, temperature: 0, ...opts });
  const json = extractJson(text);
  if (!json) return { ingredients: [], ga: {} };
  return {
    ingredients: Array.isArray(json.ingredients) ? json.ingredients : [],
    ga: json.ga && typeof json.ga === 'object' ? json.ga : {},
  };
}
