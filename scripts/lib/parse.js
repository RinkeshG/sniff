// Deterministic label parser. Converts the isolated Composition + Guaranteed
// Analysis text (from source.js) into the same fact shape extract.js produces,
// WITHOUT an LLM. Because it only copies what is literally in the text, it
// cannot hallucinate. validate.js still guards everything it returns.
//
// parseConfidence flags labels this parser could not read cleanly, so a human
// (or a careful read) can handle the long tail instead of trusting a bad parse.

// Split on top-level commas OR semicolons (some labels use ';'), respecting
// parentheses so "Minerals (Calcium, ...)" stays one ingredient.
function splitTop(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === ';') && depth === 0) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// Strip per-ingredient marketing prose and flavour preambles.
//  "Chicken Meat: A high-quality source of protein"  -> "Chicken Meat"
//  "For Sheba DUO ... Flavours: Poultry and By Products" -> "Poultry and By Products"
function cleanName(tok) {
  let s = tok.trim();
  if (/^for\b/i.test(s) && s.includes(':')) s = s.slice(s.indexOf(':') + 1).trim();
  else if (s.includes(':')) s = s.slice(0, s.indexOf(':')).trim();
  return s.replace(/^[^A-Za-z0-9]+/, '').trim(); // drop stray leading marks (OCR quotes/bullets)
}

// Strip ONLY a trailing proportion, so multi-percent names like
// "Dehydrated fish (salmon 10%, tuna 10%)" are kept intact (and pass validation).
const TRAILING_PAREN_PCT = /\s*\(\s*(?:min(?:imum)?\.?\s*|max(?:imum)?\.?\s*|approx\.?\s*)?(\d{1,2}(?:\.\d+)?)\s*%\s*\)\s*$/i;
const TRAILING_BARE_PCT = /\s+(\d{1,2}(?:\.\d+)?)\s*%\s*$/;

function parseIngredients(text) {
  if (!text) return [];
  return splitTop(text)
    .map((tok) => {
      let name = cleanName(tok);
      let pct = null;
      let m = name.match(TRAILING_PAREN_PCT);
      if (m) { pct = parseFloat(m[1]); name = name.replace(TRAILING_PAREN_PCT, ''); }
      else { m = name.match(TRAILING_BARE_PCT); if (m) { pct = parseFloat(m[1]); name = name.replace(TRAILING_BARE_PCT, ''); } }
      name = name.replace(/\*+/g, '').replace(/[.;]+$/, '').replace(/\s+/g, ' ').trim();
      return { name, pct: pct != null && pct >= 0 && pct <= 100 ? pct : null };
    })
    .filter((i) => i.name && i.name.length > 1);
}

function num(text, nutrientRe) {
  const m = text.match(nutrientRe);
  return m ? parseFloat(m[1]) : null;
}

function parseGA(text) {
  const ga = { protein: null, fat: null, fibre: null, moisture: null, ash: null, calcium: null, phosphorus: null, taurine: null, taurineListed: false };
  if (!text) return ga;
  ga.protein = num(text, /(?:crude\s+|raw\s+)?protein[^0-9%]{0,15}(\d{1,2}(?:\.\d+)?)\s*%/i);
  ga.fat = num(text, /(?:crude\s+|raw\s+)?(?:fat|fats|oils?)[^0-9%]{0,20}(\d{1,2}(?:\.\d+)?)\s*%/i);
  ga.fibre = num(text, /(?:crude\s+|raw\s+)?fib(?:re|er)[^0-9%]{0,15}(\d{1,2}(?:\.\d+)?)\s*%/i);
  ga.moisture = num(text, /moisture[^0-9%]{0,15}(\d{1,2}(?:\.\d+)?)\s*%/i);
  ga.ash = num(text, /(?:crude\s+|raw\s+)?ash(?:es)?[^0-9%]{0,15}(\d{1,2}(?:\.\d+)?)\s*%/i);
  ga.calcium = num(text, /calcium[^0-9%]{0,15}(\d{1,2}(?:\.\d+)?)\s*%/i);
  ga.phosphorus = num(text, /phosphor(?:us|ous)[^0-9%]{0,15}(\d{1,2}(?:\.\d+)?)\s*%/i);
  const t = text.match(/taurine[^0-9%]{0,15}(\d{1,5}(?:\.\d+)?)\s*(mg\/kg|%)/i);
  if (t) ga.taurine = { value: parseFloat(t[1]), unit: /mg/i.test(t[2]) ? 'mg/kg' : 'percent' };
  ga.taurineListed = /taurine/i.test(text);
  return ga;
}

// sources: { ingredientsText, gaText }. Returns { ingredients, ga, parseConfidence }.
export function parseLabel({ ingredientsText, gaText } = {}) {
  const ingredients = parseIngredients(ingredientsText);
  const ga = parseGA(gaText);
  ga.taurineListed = ga.taurineListed || /taurine/i.test(ingredientsText || '');

  // Low confidence = the parser likely missed something the source clearly had.
  const lowIngredients = !!ingredientsText && ingredients.length < 2;
  const lowGa = !!gaText && /protein/i.test(gaText) && ga.protein == null;
  return { ingredients, ga, parseConfidence: lowIngredients || lowGa ? 'low' : 'ok' };
}
