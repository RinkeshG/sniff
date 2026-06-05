// Deterministic derivations from validated label facts. Pure, no I/O, no LLM.
// Every number here is computed from disclosed values; assumptions are flagged,
// and anything we cannot compute stays null (never guessed).

import {
  hasNamedMeat,
  isGenericProtein,
  GRAIN_RE,
  WET_CARRIER_RE,
  LIST_TERMINATOR_RE,
  JUNK_RE,
  PLANT_BULK_RE,
} from './constants.js';

const r1 = (x) => Math.round(x * 10) / 10;

// Standard, low-risk assumptions used only when a value isn't disclosed.
const ASSUMED_MOISTURE_DRY = 10; // dry cat food is ~8-10% moisture
const ASSUMED_ASH = 8;           // typical when undisclosed
const ASSUMED_FIBRE = 2;         // crude fibre is usually low

export function deriveCategory({ moisture, productType, title } = {}) {
  const hay = `${productType || ''} ${title || ''}`.toLowerCase();
  if (/\b(treat|churu|creamy|temptation|dreamies|stick|jerky|biscuit|crunch|catnip)\b/.test(hay)) return 'treat';
  if (moisture != null && moisture > 50) return 'wet';
  if (/\b(gravy|jelly|pouch|\bcan\b|canned|wet|mousse|broth|loaf|pate|pâté|chunks|fillet|terrine)\b/.test(hay)) return 'wet';
  return 'dry';
}

// Therapeutic / prescription diets are formulated for a medical condition and
// must NOT be judged by the everyday meat-first/low-carb rubric. Detect them
// from explicit veterinary markers (avoid plain "urinary"/"hairball" OTC terms).
const VET_RE = /\b(veterinary|prescription|vet diet|vd|expert)\b|\b(k\/d|c\/d|i\/d|z\/d|w\/d|j\/d)\b|\b(renal|gastrointestinal|struvite|hepatic|satiety|convalescence|recovery|mobility|hypoallergenic|dermatosis|diabetic|oxalate)\b/i;
export function isVetDiet({ productType, title, brand, slug } = {}) {
  if (productType === 'prescription') return true;
  return VET_RE.test(`${brand || ''} ${title || ''} ${slug || ''}`);
}

export function proteinDryMatter(protein, moisture) {
  if (protein == null || moisture == null) return null;
  const denom = 100 - moisture;
  if (denom <= 0) return null;
  return r1((protein / denom) * 100);
}

// NFE-style carb estimate. Returns the value plus honesty flags.
export function computeCarbs(ga, category) {
  const out = { carbs: null, carbsUnreliable: false, moistureAssumed: false, ashAssumed: false, fibreAssumed: false };
  const protein = ga.protein;
  const fat = ga.fat;
  if (protein == null || fat == null) return out; // can't estimate without these

  let moisture = ga.moisture;
  if (moisture == null) {
    if (category === 'wet') return out; // wet without moisture: do not guess
    moisture = ASSUMED_MOISTURE_DRY;
    out.moistureAssumed = true;
  }
  let ash = ga.ash;
  if (ash == null) { ash = ASSUMED_ASH; out.ashAssumed = true; }
  let fibre = ga.fibre;
  if (fibre == null) { fibre = ASSUMED_FIBRE; out.fibreAssumed = true; }

  const raw = 100 - protein - fat - fibre - moisture - ash;
  const assumedCount = [out.moistureAssumed, out.ashAssumed, out.fibreAssumed].filter(Boolean).length;
  out.carbsUnreliable = raw < 0 || raw > 100 || assumedCount >= 3;
  out.carbs = r1(Math.min(100, Math.max(0, raw)));
  return out;
}

// 'full'  = everything needed disclosed (incl. moisture)
// 'estimated' = protein disclosed but some inputs assumed
// 'none'  = no protein / no guaranteed analysis
export function gaConfidence(ga, flags) {
  if (ga.protein == null) return 'none';
  const anyAssumed = flags.moistureAssumed || flags.ashAssumed || flags.fibreAssumed;
  const haveCore = ga.fat != null && ga.fibre != null && ga.moisture != null;
  return haveCore && !anyAssumed ? 'full' : 'estimated';
}

// First substantive ingredient, skipping wet-food carriers (water/broth/jelly).
function firstSubstantive(ingredients, category) {
  if (!ingredients || !ingredients.length) return null;
  if (category === 'wet') {
    for (const ing of ingredients) {
      if (!WET_CARRIER_RE.test(ing.name)) return ing;
    }
  }
  return ingredients[0];
}

// meaningful = a NAMED meat genuinely leads the list, not water and not a token
// at a trivial percentage. Returns true | false | null(unknown).
// Judge the lead phrase, not a parenthetical: "Meat and animal derivatives
// (chicken 14%)" leads with a generic source even though it names chicken inside.
const leadPhrase = (name) => String(name || '').split('(')[0].trim();

export function meatFirstMeaningful(ingredients, category) {
  const first = firstSubstantive(ingredients, category);
  if (!first) return null;
  const head = leadPhrase(first.name);
  if (isGenericProtein(head)) return false;
  if (!hasNamedMeat(head)) return false; // plant/grain/generic leads
  if (first.pct != null && first.pct < 5) return null; // "meat-first" at <5% is not real
  return true;
}

export function grainFree(ingredients, listComplete) {
  if (!ingredients || !ingredients.length) return null;
  if (!listComplete) return null; // a truncated list can hide a grain
  return !ingredients.some((i) => GRAIN_RE.test(i.name));
}

export function ingredientSplitting(ingredients) {
  if (!ingredients) return false;
  const grainCount = ingredients.filter((i) => GRAIN_RE.test(i.name)).length;
  return grainCount >= 3;
}

export function listLooksComplete(ingredientsText) {
  if (!ingredientsText) return false;
  const t = ingredientsText.trim();
  // Truncated if it ends mid-list ("and other...") or has no proper close.
  if (/\.\.\.\s*$/.test(t)) return false;
  if (/\b(and other|amongst others|etc\.?)\s*$/i.test(t)) return false;
  // A complete pet-food list almost always names additives/minerals/vitamins,
  // or at least ends with a period after a reasonable length.
  if (LIST_TERMINATOR_RE.test(t)) return true;
  return t.length > 40 && /[.)]\s*$/.test(t);
}

// How many DISTINCT named meats genuinely appear (skipping wet carriers and
// generic sources). Two-plus named meats is a real quality signal.
function countNamedMeats(ingredients, category) {
  if (!ingredients || !ingredients.length) return 0;
  let n = 0;
  for (const ing of ingredients) {
    if (category === 'wet' && WET_CARRIER_RE.test(ing.name)) continue;
    const head = leadPhrase(ing.name);
    if (isGenericProtein(head)) continue;
    if (hasNamedMeat(head)) n++;
  }
  return n;
}

// Transparency = how much the brand actually published. This is its OWN axis and
// never feeds the verdict. 'high' = full guaranteed analysis + a complete list;
// 'low' = a readable ingredient list but no numbers at all; 'medium' between.
function transparencyLevel(ga, gaConf, listComplete, firstIngredient) {
  if (!firstIngredient) return 'low';
  if (ga.protein == null) return 'low';            // ingredients only, no numbers
  if (gaConf === 'full' && listComplete) return 'high';
  return 'medium';
}

// Main entry. rawFacts: { ingredients:[{name,pct}], ingredientsText, ga:{...} }
// meta: { productType, title, lifeStage, categoryHint }
export function compute(rawFacts, meta = {}) {
  const ga = rawFacts.ga || {};
  const ingredients = rawFacts.ingredients || [];
  const category = deriveCategory({
    moisture: ga.moisture,
    productType: meta.productType,
    title: meta.title,
  }) || meta.categoryHint || 'dry';

  const carbsInfo = computeCarbs(ga, category);
  const proteinDM = proteinDryMatter(
    ga.protein,
    ga.moisture != null ? ga.moisture : (category === 'wet' ? null : ASSUMED_MOISTURE_DRY)
  );
  const flags = {
    moistureAssumed: carbsInfo.moistureAssumed,
    ashAssumed: carbsInfo.ashAssumed,
    fibreAssumed: carbsInfo.fibreAssumed,
  };
  const complete = listLooksComplete(rawFacts.ingredientsText);
  const first = firstSubstantive(ingredients, category);
  const vet = isVetDiet({ productType: meta.productType, title: meta.title, brand: meta.brand, slug: meta.slug });
  const dietType = vet ? 'vet' : (category === 'treat' ? 'treat' : 'regular');
  const treatJunk = ingredients.some((i) => /\b(colou?r|tartrazine|sunset yellow|caramel|sugar|sucrose|glucose syrup|sorbitol|humectant)\b/i.test(i.name));
  // Junk / plant-bulking flags apply to ALL foods (not just treats) and feed the
  // quality score as real negatives.
  const junk = ingredients.some((i) => JUNK_RE.test(i.name));
  const plantBulk = ingredients.some((i) => PLANT_BULK_RE.test(i.name));
  const namedMeatCount = countNamedMeats(ingredients, category);
  const gaConf = gaConfidence(ga, flags);

  return {
    category,
    dietType,
    treatJunk,
    junk,
    plantBulk,
    namedMeatCount,
    secondNamedMeat: namedMeatCount >= 2,
    meatPctRead: first && first.pct != null ? first.pct : null,
    lifeStage: meta.lifeStage || null,
    firstIngredient: first ? first.name : null,
    proteinAsFed: ga.protein ?? null,
    proteinDM,
    proteinDMEstimated: flags.moistureAssumed && ga.protein != null,
    carbs: carbsInfo.carbs,
    carbsUnreliable: carbsInfo.carbsUnreliable,
    carbsEstimated: flags.moistureAssumed || flags.ashAssumed || flags.fibreAssumed,
    caP: ga.calcium != null && ga.phosphorus != null && ga.phosphorus > 0
      ? r1(ga.calcium / ga.phosphorus) : null,
    taurinePct: ga.taurinePct ?? null,
    taurineDisclosed: !!ga.taurineListed || ga.taurinePct != null,
    grainFree: grainFree(ingredients, complete),
    meatFirst: meatFirstMeaningful(ingredients, category),
    genericProtein: !!first && isGenericProtein(leadPhrase(first.name)),
    ingredientSplitting: ingredientSplitting(ingredients),
    listComplete: complete,
    gaConfidence: gaConf,
    transparency: transparencyLevel(ga, gaConf, complete, first ? first.name : null),
    ...flags,
  };
}
