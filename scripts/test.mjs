// Deterministic-core tests. Run: node --test scripts/test.mjs
// Fixtures use REAL label text pulled from Supertails .json during planning,
// so these assert the pipeline against ground truth, not against itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateFacts } from './lib/validate.js';
import { compute, proteinDryMatter, computeCarbs } from './lib/compute.js';
import { score } from './lib/rubric.js';
import { assemble, clean } from './lib/schema.js';
import { lintVoice } from './lib/voice.js';
import { fetchSupertailsLabel } from './lib/source.js';
import { parseLabel } from './lib/parse.js';
import { productIdentity, labelIdentity, identityConflict, consistencyFlags, brandKey, leadMeat } from './lib/identity.js';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── Real fixture: Farmina Matisse Kitten (full label) ──────────────────────
const FARMINA_ING =
  'Dehydrated chicken meat (36%), rice (20%), chicken fat, corn, dehydrated fish (6%), corn gluten, dehydrated whole eggs (4%), hydrolyzed animal proteins, dried beetroot pulp, fish oil, vegetable oil, sodium chloride, potassium chloride, dihydrate calcium sulfate, dried brewer\'s yeast, mono-dicalcium phosphate, calcium carbonate.';
const FARMINA_GA =
  'Raw protein 36.00%; raw fats and oils 14.00%; raw fiber 0.90%; raw ashes 7.30%; Calcium 1.25%; Phosphorus 1.00%; Magnesium 0.09%; Taurine 2900mg/kg.';

const farminaExtract = {
  ingredients: [
    { name: 'Dehydrated chicken meat', pct: 36 },
    { name: 'rice', pct: 20 },
    { name: 'chicken fat', pct: null },
    { name: 'corn', pct: null },
    { name: 'dehydrated fish', pct: 6 },
    { name: 'corn gluten', pct: null },
    { name: 'dehydrated whole eggs', pct: 4 },
    { name: 'hydrolyzed animal proteins', pct: null },
  ],
  ga: {
    protein: 36, fat: 14, fibre: 0.9, moisture: null, ash: 7.3,
    calcium: 1.25, phosphorus: 1.0,
    taurine: { value: 2900, unit: 'mg/kg' }, taurineListed: true,
  },
};

test('Farmina: validate keeps real facts, normalizes taurine', () => {
  const { facts, errors, firstIngredientValid } = validateFacts(farminaExtract, {
    ingredientsText: FARMINA_ING, gaText: FARMINA_GA,
  });
  assert.equal(firstIngredientValid, true);
  assert.equal(facts.ga.protein, 36);
  assert.equal(facts.ga.taurinePct, 0.29); // 2900 mg/kg -> 0.29%
  assert.equal(facts.ingredients.length, 8);
  assert.deepEqual(errors, []);
});

test('Farmina: computes to 40% DM protein, ~32% carbs, contains grain', () => {
  const { facts } = validateFacts(farminaExtract, { ingredientsText: FARMINA_ING, gaText: FARMINA_GA });
  const c = compute(facts, { title: 'Farmina Matisse Kitten Cat Dry Food', productType: 'dry' });
  assert.equal(c.proteinDM, 40);          // 36 / (100-10 assumed) * 100
  assert.equal(c.grainFree, false);       // rice + corn present
  assert.ok(c.carbs >= 30 && c.carbs <= 34, `carbs ~32, got ${c.carbs}`);
  assert.equal(c.meatFirst, true);
  assert.equal(c.category, 'dry');
});

test('Farmina: verdict is NOT a Strong choice and NOT grain-free (refutes bad data)', () => {
  const { facts } = validateFacts(farminaExtract, { ingredientsText: FARMINA_ING, gaText: FARMINA_GA });
  const c = compute(facts, { title: 'Farmina Matisse Kitten Cat Dry Food' });
  const sk = score(c);
  assert.equal(sk.verdict.label, 'Okay for now');
  const a = assemble(sk, null, { source: 'Supertails', completeness: 'full' });
  const firstIng = a.metrics.find((m) => m.name === 'First ingredient');
  assert.match(firstIng.value, /chicken/i);
  assert.notEqual(firstIng.value, 'Farmina');
  // no reason should claim grain-free
  assert.ok(!a.reasons.some((r) => /grain-free/i.test(r.a)));
});

// ── Real fixture: Royal Canin Kitten (ingredients only, no GA) ─────────────
const RC_ING =
  'Composition: dehydrated poultry protein, rice, vegetable protein isolate*, animal fats, maize flour, hydrolysed animal proteins, wheat flour, maize gluten, yeasts and parts thereof, beet pulp, vegetable fibres, fish oil, soya oil, minerals, fructo-oligo-saccharides (0.38%), psyllium husks and seeds, hydrolysed yeast, yeast extracts, marigold extract (source of lutein).';

const rcExtract = {
  ingredients: [
    { name: 'dehydrated poultry protein', pct: null },
    { name: 'rice', pct: null },
    { name: 'vegetable protein isolate', pct: null },
    { name: 'animal fats', pct: null },
    { name: 'maize flour', pct: null },
  ],
  ga: { protein: null, fat: null, fibre: null, moisture: null, ash: null, calcium: null, phosphorus: null, taurine: null, taurineListed: false },
};

test('Royal Canin: ingredients-only -> protein/carbs/taurine "Not disclosed", capped verdict', () => {
  const { facts } = validateFacts(rcExtract, { ingredientsText: RC_ING, gaText: '' });
  const c = compute(facts, { title: 'Royal Canin Kitten Cat Dry Food' });
  assert.equal(c.gaConfidence, 'none');
  assert.equal(c.proteinDM, null);
  assert.equal(c.carbs, null);
  const sk = score(c);
  // meat leads but no GA -> cannot be Strong/Good
  assert.ok(['Okay for now', 'Not ideal daily'].includes(sk.verdict.label), sk.verdict.label);
  const a = assemble(sk, null, { source: 'Supertails', completeness: 'partial' });
  assert.equal(a.metrics.find((m) => m.name === 'Protein').value, 'Not disclosed');
  assert.equal(a.metrics.find((m) => m.name === 'Protein').status, 'missing');
});

// ── Guard tests ────────────────────────────────────────────────────────────
test('validate drops hallucinated ingredient and GA number not in source', () => {
  const { facts, dropped, errors } = validateFacts(
    {
      ingredients: [{ name: 'Tuna', pct: null }, { name: 'Unicorn meat', pct: null }],
      ga: { protein: 99, fat: null, fibre: null, moisture: null, ash: null, calcium: null, phosphorus: null, taurine: null, taurineListed: false },
    },
    { ingredientsText: 'Tuna, water, fish oil.', gaText: 'Crude protein 12%.' }
  );
  assert.deepEqual(dropped, ['Unicorn meat']);
  assert.equal(facts.ga.protein, null); // 99 not in GA text -> dropped
  assert.ok(errors.length >= 1);
});

test('validate rejects a junk/title token as first ingredient', () => {
  const { firstIngredientValid } = validateFacts(
    { ingredients: [{ name: 'Farmina', pct: null }], ga: {} },
    { ingredientsText: 'Farmina Matisse premium recipe', gaText: '' }
  );
  assert.equal(firstIngredientValid, false);
});

test('compute math: dry-matter protein and carb clamp', () => {
  assert.equal(proteinDryMatter(36, 10), 40);
  assert.equal(proteinDryMatter(40, null), null);
  const c = computeCarbs({ protein: 90, fat: 30, fibre: 5, moisture: 10, ash: 8 }, 'dry');
  assert.equal(c.carbsUnreliable, true); // raw negative -> clamped + flagged
  assert.equal(c.carbs, 0);
});

test('grain-free is unknown (null) when the ingredient list is truncated', () => {
  const { facts } = validateFacts(
    { ingredients: [{ name: 'Chicken', pct: null }], ga: {} },
    { ingredientsText: 'Chicken, rice and other...', gaText: '' }
  );
  const c = compute(facts, { title: 'x dry' });
  assert.equal(c.grainFree, null);
});

test('clean() strips em-dashes', () => {
  assert.equal(clean('great food — really'), 'great food, really');
  assert.ok(!clean('a — b — c').includes('—'));
});

test('no-ingredients -> Not transparent enough', () => {
  const c = compute({ ingredients: [], ingredientsText: '', ga: {} }, {});
  const sk = score(c);
  assert.equal(sk.verdict.label, 'Not transparent enough');
});

// ── Voice lint (the safety net for the prose layer) ────────────────────────
const grainComputed = { grainFree: false, proteinDM: 40, proteinAsFed: 36, carbs: 32, carbsUnreliable: false, taurinePct: 0.29, caP: 1.25, meatFirst: true };
const skel2 = { verdict: { label: 'Okay for now' }, reasons: [{ status: 'good', q: 'a', a: 'b' }, { status: 'caution', q: 'c', a: 'd' }] };

test('voice lint rejects an unbacked grain-free claim', () => {
  const v = { summary: 'A great grain-free pick.', reasons: [{ q: 'x', a: 'y' }, { q: 'z', a: 'w' }] };
  assert.equal(lintVoice(v, grainComputed, skel2).ok, false);
});

test('voice lint rejects a fabricated percentage', () => {
  const v = { summary: 'It has 99% protein.', reasons: [{ q: 'x', a: 'y' }, { q: 'z', a: 'w' }] };
  assert.equal(lintVoice(v, grainComputed, skel2).ok, false);
});

test('voice lint rejects forbidden marketing words', () => {
  const v = { summary: 'A complete and balanced meal.', reasons: [{ q: 'x', a: 'y' }, { q: 'z', a: 'w' }] };
  assert.equal(lintVoice(v, grainComputed, skel2).ok, false);
});

test('voice lint passes clean, supported copy', () => {
  const v = {
    summary: 'Leads with chicken and runs about 40% protein. Carbs sit near 32%, a bit high.',
    tag: 'meat-first, some grain', parentTake: 'Fine to feed.', action: 'Compare with a lower-carb option.', note: 'Medium concern.',
    fitsIf: ['Healthy adults'], doesntFitIf: ['Cats off grains'],
    reasons: [{ q: 'Chicken leads', a: 'The first ingredient is chicken.' }, { q: 'Carbs a bit high', a: 'Around 32%.' }],
  };
  assert.equal(lintVoice(v, grainComputed, skel2).ok, true);
});

// ── Source: section isolation with an injected fetch (no network) ──────────
const FARMINA_BODY = `<p><strong>Composition:</strong> ${FARMINA_ING}</p>
<p><strong>Analytical constituents:</strong> ${FARMINA_GA}</p>
<p><strong>Feeding guide:</strong> Feed 50g per day for a 4kg cat.</p>`;

function fakeFetch(body) {
  return async () => ({ ok: true, json: async () => ({ product: { title: 'Farmina Matisse Kitten Cat Dry Food', vendor: 'Farmina', body_html: body } }) });
}

test('source isolates Composition + Analytical sections, completeness full', async () => {
  const res = await fetchSupertailsLabel(
    { slug: 'farmina-matisse-kitten', brand: 'Farmina · Dry food', product_link: 'https://supertails.com/products/farmina-matisse-kitten' },
    { fetch: fakeFetch(FARMINA_BODY) }
  );
  assert.equal(res.identityOk, true);
  assert.equal(res.completeness, 'full');
  assert.match(res.ingredientsText, /Dehydrated chicken meat/);
  assert.match(res.gaText, /protein 36/i);
  assert.ok(!/Feeding guide/i.test(res.ingredientsText));
});

test('source abstains on marketing-only body (no labeled sections)', async () => {
  const res = await fetchSupertailsLabel(
    { slug: 'x', brand: 'Farmina', product_link: 'https://supertails.com/products/x' },
    { fetch: fakeFetch('<p>The best food for your cat, made with love!</p>') }
  );
  assert.equal(res.completeness, 'none');
  assert.equal(res.ingredientsText, null);
});

// ── Rubric edge branches ───────────────────────────────────────────────────
test('plant/grain leading the list -> Not ideal daily', () => {
  const c = compute({ ingredients: [{ name: 'maize', pct: null }, { name: 'chicken meal', pct: null }], ingredientsText: 'maize, chicken meal, vitamins.', ga: {} }, { title: 'x dry' });
  assert.equal(c.meatFirst, false);
  assert.equal(score(c).verdict.label, 'Not ideal daily');
});

test('generic "animal derivatives" leading -> Caution', () => {
  const c = compute({ ingredients: [{ name: 'meat and animal derivatives', pct: null }, { name: 'cereals', pct: null }], ingredientsText: 'meat and animal derivatives (4% chicken), cereals, minerals.', ga: {} }, { title: 'x dry' });
  assert.equal(c.genericProtein, true);
  assert.equal(score(c).verdict.label, 'Caution');
});

test('veterinary/prescription diet is not judged as everyday food', () => {
  const c = compute({ ingredients: [{ name: 'rice', pct: 45 }, { name: 'dried eggs', pct: 20 }, { name: 'pea protein', pct: null }], ingredientsText: 'rice (45%), dried eggs (20%), chicken fat, pea protein, minerals.', ga: {} }, { title: 'Calibra VD Cat Renal Cardiac', slug: 'calibra-vd-cat-renal-cardiac-dry-food', productType: 'dry' });
  assert.equal(c.dietType, 'vet');
  assert.equal(score(c).verdict.label, 'Vet-directed diet');
});

test('a treat is judged as a treat, not a daily meal, and junk is flagged', () => {
  const c = compute({ ingredients: [{ name: 'Real Chicken', pct: null }, { name: 'Rice Flour', pct: null }, { name: 'Sugar', pct: null }], ingredientsText: 'Real Chicken, Rice Flour, Sugar, Minerals And Vitamins.', ga: { protein: 12 } }, { title: 'Drools Biscuit Treat', productType: 'treat' });
  assert.equal(c.dietType, 'treat');
  const sk = score(c);
  assert.equal(sk.verdict.label, 'Treat, not a meal');
  assert.ok(sk.reasons.some((r) => /colou?r|sugar/i.test(r.a)));
});

// ── Identity & consistency gate (the wrong-but-real-label guard) ────────────
// Each fixture mirrors a real contamination case found in the live DB.

test('identity: dry product + wet pouch label (moisture 84) -> HARD form conflict', () => {
  const prod = productIdentity({ brand: 'Whiskas · Dry food', title: 'Ocean Fish, Adult 1+', category: 'dry', type: 'cat', life_stage: 'adult', slug: 'whiskas-ocean-fish-adult' });
  const label = labelIdentity({
    facts: { ga: { moisture: 84 }, ingredientsText: 'wholegrain cereals (corn, rice, wheat), ...' },
    sourceUrl: 'https://headsupfortails.com/products/whiskas-ocean-fish-adult-wet-cat-food-80-g',
    firstIngredient: 'Wholegrain cereals (corn, rice, wheat)',
  });
  const c = identityConflict(prod, label, 'wholegrain cereals');
  assert.equal(c.ok, false);
  assert.ok(c.hard.some((h) => /form/.test(h)), c.hard.join(','));
});

test('identity: cat product + dog-food label -> HARD species conflict', () => {
  const prod = productIdentity({ brand: 'Farmina N&D · Dry food', title: 'Quinoa and Lamb Adult Cat Dry Food', category: 'dry', type: 'cat', life_stage: 'adult' });
  const label = labelIdentity({
    facts: { ga: { moisture: 9 }, ingredientsText: 'lamb, quinoa, ...' },
    sourceUrl: 'https://headsupfortails.com/products/farmina-n-d-lamb-quinoa-grain-free-adult-dry-dog-food',
    firstIngredient: 'lamb',
  });
  const c = identityConflict(prod, label, 'lamb, quinoa');
  assert.equal(c.ok, false);
  assert.ok(c.hard.some((h) => /species/.test(h)), c.hard.join(','));
});

test('identity: life-stage mismatch is SOFT (review), not abstain (metadata is messy)', () => {
  const prod = productIdentity({ brand: 'Whiskas · Dry food', title: 'Mackerel Kitten', category: 'dry', type: 'cat', life_stage: 'kitten' });
  const label = labelIdentity({ sourceUrl: 'https://x.com/products/whiskas-mackerel-adult-dry-cat-food', firstIngredient: 'cereals' });
  const c = identityConflict(prod, label, 'cereals');
  assert.equal(c.ok, true);               // no hard conflict -> not abstained
  assert.ok(c.soft.some((s) => /life-stage/.test(s)), c.soft.join(','));
});

test('identity: Me-O dry product + Whiskas WET label -> HARD form (abstain), SOFT brand', () => {
  // The real contamination: a Me-O dry SKU wearing the Whiskas mackerel-in-jelly
  // (wet, moisture 87) label. Form catches it hard; brand is flagged soft.
  const prod = productIdentity({ brand: 'Me-O · Dry food', title: 'Mackerel, Adult', category: 'dry', type: 'cat', life_stage: 'adult' });
  const label = labelIdentity({
    facts: { ga: { moisture: 87 }, ingredientsText: 'fish and fish derivatives, ...' },
    sourceUrl: 'https://headsupfortails.com/products/whiskas-mackerel-in-jelly-adult-cat-wet-food-80-gm-pack',
    firstIngredient: 'fish and fish derivatives',
  });
  const c = identityConflict(prod, label, 'fish and fish derivatives');
  assert.equal(c.ok, false);
  assert.ok(c.hard.some((h) => /form/.test(h)), c.hard.join(','));
  assert.ok(c.soft.some((s) => /brand/.test(s)), c.soft.join(','));
});

test('identity: salmon product + tuna-led label -> SOFT flavour (review), not abstain', () => {
  const prod = productIdentity({ brand: 'Signature · Wet food', title: 'Grain Zero Salmon Mousse', category: 'wet', type: 'cat', life_stage: 'adult' });
  const label = labelIdentity({
    facts: { ga: { moisture: 78 }, ingredientsText: 'tuna, fish broth, sunflower oil' },
    sourceUrl: 'https://supertails.com/products/signature-grain-zero-salmon-mousse-adult-cat-wet-food.json',
    firstIngredient: 'tuna',
  });
  const c = identityConflict(prod, label, 'tuna, fish broth, sunflower oil');
  assert.equal(c.ok, true);                 // no hard conflict
  assert.ok(c.soft.some((s) => /flavour/.test(s)), c.soft.join(','));
});

test('identity: honest flavoured food (Whiskas Tuna = cereals) -> NO conflict', () => {
  const prod = productIdentity({ brand: 'Whiskas · Dry food', title: 'Tuna, Adult 1+', category: 'dry', type: 'cat', life_stage: 'adult' });
  const label = labelIdentity({
    facts: { ga: { moisture: null }, ingredientsText: 'cereals (corn and/or wheat and/or rice), meat and animal derivatives' },
    sourceUrl: 'https://supertails.com/products/whiskas-tuna-flavour-adult-dry-cat-food.json',
    firstIngredient: 'cereals (corn and/or wheat and/or rice)',
  });
  const c = identityConflict(prod, label, 'cereals (corn and/or wheat and/or rice), meat and animal derivatives');
  assert.equal(c.ok, true);
  assert.equal(c.soft.length, 0);
});

test('identity: manufacturer aliases never false-conflict', () => {
  // Advance is made by Affinity; Friskies by Purina; Matisse is Farmina N&D; Lara is Versele-Laga.
  const cases = [
    [{ brand: 'Affinity Petcare · Dry food', title: 'Advance Veterinary Diets Urinary Cat', category: 'dry', type: 'cat', life_stage: 'adult' }, 'advance-veterinary-diets-urinary-cat'],
    [{ brand: 'Purina Felix · Dry food', title: 'Friskies Kitten', category: 'dry', type: 'cat', life_stage: 'kitten' }, 'friskies-kitten-dry-cat-food'],
    [{ brand: 'Farmina · Dry food', title: 'Matisse Salmon and Tuna Adult', category: 'dry', type: 'cat', life_stage: 'adult' }, 'matisse-salmon-tuna-adult'],
    [{ brand: 'Versele Laga · Dry food', title: 'Lara Lamb Adult', category: 'dry', type: 'cat', life_stage: 'adult' }, 'lara-lamb-adult-cat-dry-food'],
  ];
  for (const [meta, handle] of cases) {
    const c = identityConflict(productIdentity(meta), labelIdentity({ sourceUrl: `https://supertails.com/products/${handle}.json` }), '');
    assert.equal(c.hard.length, 0, `${meta.title}: ${c.hard.join(',')}`);
  }
});

test('consistency: wet food with no moisture cannot be "full"', () => {
  const wet = consistencyFlags({ facts: { ga: { protein: 10, fat: 5, moisture: null } }, prodForm: 'wet', harvesterCompleteness: 'full' });
  assert.equal(wet.completeness, 'partial');
  const dry = consistencyFlags({ facts: { ga: { protein: 32, fat: 12, moisture: 10 } }, prodForm: 'dry', harvesterCompleteness: 'full' });
  assert.equal(dry.completeness, 'full');
});

test('consistency: a guaranteed analysis summing over 100% is implausible', () => {
  const bad = consistencyFlags({ facts: { ga: { protein: 80, fat: 30, fibre: 5, moisture: 10, ash: 8 } }, prodForm: 'dry', harvesterCompleteness: 'full' });
  assert.equal(bad.gaImplausible, true);
  const okFacts = consistencyFlags({ facts: { ga: { protein: 36, fat: 14, fibre: 0.9, moisture: 10, ash: 7.3 } }, prodForm: 'dry', harvesterCompleteness: 'full' });
  assert.equal(okFacts.gaImplausible, false);
});

test('identity helpers: brandKey + leadMeat behave', () => {
  assert.equal(brandKey('Me-O · Dry food'), 'me');
  assert.equal(brandKey('whiskas-mackerel-in-jelly-adult'), 'whiskas');
  assert.equal(brandKey('advance-veterinary-diets-urinary-cat'), 'affinity');
  assert.equal(brandKey('a generic handle with no brand'), '');
  assert.equal(leadMeat('Dehydrated chicken meat (36%)'), 'chicken');
  assert.equal(leadMeat('meat and animal derivatives (4% chicken)'), null); // generic lead is not a named claim
});

test('parse: a single named-meat ingredient (freeze-dried treat) is OK, not a bad parse', () => {
  // "Ingredients: Tuna" / "Whole Shrimp" are genuinely complete single-ingredient
  // labels, so they must NOT be flagged low-confidence and abstained.
  const tuna = parseLabel({ ingredientsText: 'Tuna', gaText: '' });
  assert.equal(tuna.parseConfidence, 'ok');
  assert.equal(tuna.ingredients.length, 1);
  // but a single NON-meat ingredient is still a truncation signal -> low.
  const rice = parseLabel({ ingredientsText: 'Rice', gaText: '' });
  assert.equal(rice.parseConfidence, 'low');
});

test('identity: "Cats and Kittens" label is all-life-stages, no false conflict vs adult', () => {
  const prod = productIdentity({ brand: 'Goofy Tails · Wet food', title: 'Mackerel and Seaweed', category: 'wet', type: 'cat', life_stage: 'adult' });
  const label = labelIdentity({
    facts: { ga: { moisture: 81 }, ingredientsText: 'mackerel, water' },
    sourceUrl: 'https://goofytails.com/products/goofy-tails-mackerel-and-seaweed-wet-cat-food-and-kitten-food',
    firstIngredient: 'Mackerel',
  });
  const c = identityConflict(prod, label, 'mackerel, water');
  assert.equal(c.ok, true);
  assert.equal(c.soft.length, 0, c.soft.join(','));
});

// ── Golden set: real labels, independent ground truth, per-product ──────────
function loadGolden() {
  const dir = fileURLToPath(new URL('./golden/', import.meta.url));
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(dir + f, 'utf8')));
}

for (const fx of loadGolden()) {
  test(`golden: ${fx.name}`, () => {
    const { facts, firstIngredientValid } = validateFacts(fx.extracted, fx.source);
    const c = compute(facts, fx.meta);
    const sk = score(c);
    const a = assemble(sk, null, { source: 'test', completeness: fx.expect.completeness });

    assert.equal(sk.verdict.label, fx.expect.verdict, `verdict for ${fx.name}`);
    assert.equal(c.proteinDM, fx.expect.proteinDM, `proteinDM for ${fx.name}`);
    assert.equal(c.grainFree, fx.expect.grainFree, `grainFree for ${fx.name}`);

    const firstMetric = a.metrics.find((m) => m.name === 'First ingredient');
    if (fx.expect.firstIngredient == null) {
      assert.equal(firstMetric.value, 'Not disclosed');
    } else {
      assert.equal(firstIngredientValid, true);
      assert.match(firstMetric.value.toLowerCase(), new RegExp(fx.expect.firstIngredient));
    }
    // The headline guarantee: a confident-looking green verdict never rides on a
    // value we could not verify.
    if (['Strong choice', 'Good enough'].includes(sk.verdict.label)) {
      assert.notEqual(c.proteinDM, null, `${fx.name} claims ${sk.verdict.label} without protein`);
      assert.equal(c.meatFirst, true);
    }
  });
}

// The deterministic parser, run on the real source text, must reproduce the
// same outcome as the hand-coded ground truth (proves it replaces the LLM step).
for (const fx of loadGolden()) {
  test(`parser parity: ${fx.name}`, () => {
    const parsed = parseLabel(fx.source);
    const { facts } = validateFacts(parsed, fx.source);
    const c = compute(facts, fx.meta);
    const sk = score(c);
    assert.equal(sk.verdict.label, fx.expect.verdict, `parser verdict ${fx.name}`);
    assert.equal(c.proteinDM, fx.expect.proteinDM, `parser proteinDM ${fx.name}`);
    assert.equal(c.grainFree, fx.expect.grainFree, `parser grainFree ${fx.name}`);
    if (fx.expect.firstIngredient) assert.match((c.firstIngredient || '').toLowerCase(), new RegExp(fx.expect.firstIngredient));
  });
}
