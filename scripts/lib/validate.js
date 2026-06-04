// Guardrails between the LLM extractor and the deterministic pipeline.
// Nothing the model returns is trusted until it survives these checks:
//  - every ingredient name must appear verbatim in the source ingredient text
//  - the first ingredient must not be a junk/title/stopword token
//  - every guaranteed-analysis number must appear verbatim in the GA text
//  - units are normalized and values must be physically plausible
// Anything that fails is dropped to null (treated as "not disclosed"), never used.

import { FIRST_ING_JUNK } from './constants.js';

const normalize = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9%.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const numbersIn = (text) =>
  (String(text || '').match(/\d+(?:[.,]\d+)?/g) || []).map((n) => parseFloat(n.replace(',', '.')));

const close = (a, b) => Math.abs(a - b) < 0.05;

// as-fed plausibility ranges (percent). Freeze-dried treats can be high-protein,
// so protein's upper bound is generous; clearly-impossible values are rejected.
const RANGES = {
  protein: [5, 95],
  fat: [0.5, 70],
  fibre: [0, 20],
  moisture: [0, 92],
  ash: [0, 15],
  calcium: [0, 5],
  phosphorus: [0, 5],
};

function checkNumber(field, value, gaNumbers) {
  if (value == null) return { value: null };
  if (typeof value !== 'number' || !isFinite(value)) return { value: null, error: `${field}: not a number` };
  if (!gaNumbers.some((n) => close(n, value))) return { value: null, error: `${field}: ${value} not found verbatim in label` };
  const [lo, hi] = RANGES[field] || [0, 100];
  if (value < lo || value > hi) return { value: null, error: `${field}: ${value} out of plausible range` };
  return { value };
}

function validateIngredients(rawIngredients, ingredientsText) {
  const textNorm = normalize(ingredientsText);
  const dropped = [];
  const kept = [];
  for (const ing of rawIngredients || []) {
    const nameNorm = normalize(ing && ing.name);
    if (!nameNorm) continue;
    // every token of the ingredient name must be present in the source text
    if (!textNorm.includes(nameNorm)) { dropped.push(ing.name); continue; }
    let pct = ing.pct;
    if (typeof pct !== 'number' || !isFinite(pct) || pct < 0 || pct > 100) pct = null;
    kept.push({ name: String(ing.name).trim(), pct });
  }
  return { ingredients: kept, dropped };
}

function firstIngredientValid(ingredients) {
  if (!ingredients.length) return false;
  const first = normalize(ingredients[0].name);
  if (first.length < 3) return false;
  if (FIRST_ING_JUNK.has(first)) return false;
  // a single short stopword-like token is invalid; real ingredients are nouns
  if (FIRST_ING_JUNK.has(first.split(' ')[0]) && first.split(' ').length === 1) return false;
  return true;
}

// extracted: { ingredients:[{name,pct}], ga:{ protein,fat,fibre,moisture,ash,calcium,
//             phosphorus, taurine:{value,unit}|null, taurineListed } }
// sources:   { ingredientsText, gaText }
export function validateFacts(extracted = {}, sources = {}) {
  const errors = [];
  const { ingredients, dropped } = validateIngredients(extracted.ingredients, sources.ingredientsText);
  if (dropped.length) errors.push(`dropped ${dropped.length} unverifiable ingredient(s): ${dropped.join(', ')}`);

  const gaNumbers = numbersIn(sources.gaText);
  const rawGa = extracted.ga || {};
  const ga = {};
  for (const field of ['protein', 'fat', 'fibre', 'moisture', 'ash', 'calcium', 'phosphorus']) {
    const res = checkNumber(field, rawGa[field], gaNumbers);
    ga[field] = res.value;
    if (res.error) errors.push(res.error);
  }

  // Taurine: normalize mg/kg -> % (2900 mg/kg = 0.29%). Verify the source number.
  let taurinePct = null;
  const t = rawGa.taurine;
  if (t && typeof t.value === 'number' && isFinite(t.value)) {
    if (gaNumbers.some((n) => close(n, t.value))) {
      if (t.unit === 'mg/kg') taurinePct = Math.round((t.value / 10000) * 1000) / 1000;
      else if (t.unit === 'percent') taurinePct = t.value;
      if (taurinePct != null && (taurinePct < 0 || taurinePct > 2)) { taurinePct = null; errors.push(`taurine out of range`); }
    } else {
      errors.push(`taurine: ${t.value} not found verbatim in label`);
    }
  }
  ga.taurinePct = taurinePct;
  ga.taurineListed = !!extracted.ga?.taurineListed || taurinePct != null;

  return {
    facts: { ingredients, ingredientsText: sources.ingredientsText || '', ga },
    dropped,
    errors,
    firstIngredientValid: firstIngredientValid(ingredients),
  };
}
