// The Sniff scoring rubric: explicit, versioned, deterministic.
// Thresholds are anchored to recognized feline standards so the baselines are
// defensible, not vibes:
//   - AAFCO cat maintenance min crude protein ~26% DM; growth/kitten ~30% DM.
//   - FEDIAF aligns; below 30% DM is genuinely low for an obligate carnivore.
//   - Cats have ~no dietary carb requirement; we treat <25% as good, >35% as high.
//   - Taurine (AAFCO): min 0.10% (dry) / 0.20% (wet) DM; disclosure is the gate.
// Boundaries round to the LOWER tier (39.9% scores as the band under 40), so a
// small extraction error never flips a verdict upward.
//
// This module produces a COMPLETE, correct (if plain) analysis on its own. The
// voice layer only makes the prose warmer; correctness never depends on the LLM.

export const RUBRIC_VERSION = '2026-06-05';

export const THRESHOLDS = {
  proteinDM: { good: 40, acceptable: 30 }, // %, dry matter
  carbs: { good: 25, high: 35 },           // %, estimated NFE
};

const LABEL_CLASS = {
  'Strong choice': 'vp-good',
  'Good choice': 'vp-good',
  'Okay for now': 'vp-okay',
  'Not ideal daily': 'vp-weak',
  'Caution': 'vp-weak',
  'Not transparent enough': 'vp-weak',
  'Vet-directed diet': 'vp-okay',
  'Treat, not a meal': 'vp-okay',
};

const TIER_RANK = {
  'Caution': 0, 'Not ideal daily': 1, 'Okay for now': 2, 'Good choice': 3, 'Strong choice': 4,
};

// ── Metrics ──────────────────────────────────────────────────────────────
function metricFirstIngredient(c) {
  if (!c.firstIngredient) {
    return { key: 'first', name: 'First ingredient', value: 'Not disclosed', status: 'missing', target: 'Should be a named meat', statusLabel: 'Not disclosed' };
  }
  let status = 'caution', statusLabel = 'Worth a look';
  if (c.meatFirst === true) { status = 'good'; statusLabel = 'Named meat'; }
  else if (c.genericProtein) { statusLabel = 'Generic source'; }
  return { key: 'first', name: 'First ingredient', value: c.firstIngredient, status, target: 'Should be a named meat', statusLabel };
}

function metricProtein(c) {
  if (c.proteinDM == null) {
    return { key: 'protein', name: 'Protein', value: 'Not disclosed', status: 'missing', target: 'Dry matter; good 40%+', statusLabel: 'Not disclosed' };
  }
  const good = c.proteinDM >= THRESHOLDS.proteinDM.good;
  const ok = c.proteinDM >= THRESHOLDS.proteinDM.acceptable;
  return {
    key: 'protein', name: 'Protein',
    value: `${c.proteinDM}%`,
    status: good ? 'good' : (ok ? 'caution' : 'caution'),
    target: c.proteinDMEstimated ? 'Dry matter (estimated); good 40%+' : 'Dry matter; good 40%+',
    statusLabel: good ? 'In range' : (ok ? 'A bit low' : 'Low'),
  };
}

function metricCarbs(c) {
  if (c.carbs == null || c.carbsUnreliable) {
    return { key: 'carbs', name: 'Carbs', value: 'Not disclosed', status: 'missing', target: 'Estimated; good under 25%', statusLabel: 'Not disclosed' };
  }
  const good = c.carbs < THRESHOLDS.carbs.good;
  return {
    key: 'carbs', name: 'Carbs',
    value: `${c.carbs}%`,
    status: good ? 'good' : 'caution',
    target: c.carbsEstimated ? 'Estimated; good under 25%' : 'Calculated; good under 25%',
    statusLabel: good ? 'In range' : (c.carbs > THRESHOLDS.carbs.high ? 'High' : 'A bit high'),
  };
}

function metricTaurine(c) {
  if (!c.taurineDisclosed) {
    return { key: 'taurine', name: 'Taurine (heart & eyes)', value: 'Not disclosed', status: 'missing', target: 'Should be listed', statusLabel: 'Not disclosed' };
  }
  return {
    key: 'taurine', name: 'Taurine (heart & eyes)',
    value: c.taurinePct != null ? `${c.taurinePct}%` : 'Listed',
    status: 'good', target: 'Should be listed', statusLabel: 'Listed',
  };
}

export function buildMetrics(c) {
  return [metricFirstIngredient(c), metricProtein(c), metricCarbs(c), metricTaurine(c)];
}

// ── Quality score ─────────────────────────────────────────────────────────
// The verdict is led by the INGREDIENT DECK (what the parent can actually see),
// refined by macros ONLY when they're disclosed. A missing number scores 0 (it
// never drags a clean food down). Disclosure can lift a food to the very top
// (Strong choice) but can never penalise it. This is the whole philosophy:
// "clean ingredients = good food; missing macros are shown, not punished."
export function qualityScore(c) {
  let s = 0;

  // The deck (primary signal)
  if (c.meatFirst === true) s += 3;
  if (c.meatFirst === false) s -= 3;            // a plant/grain genuinely leads
  if (c.secondNamedMeat) s += 1;                // a real second named meat
  if (c.meatPctRead != null &&
      ((c.category === 'wet' && c.meatPctRead >= 40) ||
       (c.category !== 'wet' && c.meatPctRead >= 26))) s += 1;
  if (c.grainFree === true) s += 1;
  if (c.grainFree === false) s -= 1;            // some grain in the mix
  if (c.plantBulk) s -= 1;                      // plant protein padding the number
  // Note: heavy cereal stacking (ingredientSplitting) isn't scored here; it caps
  // the verdict at "Okay for now" in decideVerdict, which matches how a parent
  // reads a meat-first food that's still cut with a lot of grain.
  if (c.junk) s -= 3;                           // colours / sugar / artificial preservatives

  // Macros — refine ONLY when disclosed; absence is neutral (0)
  if (c.proteinDM != null) {
    if (c.proteinDM >= THRESHOLDS.proteinDM.good) s += 2;
    else if (c.proteinDM >= THRESHOLDS.proteinDM.acceptable) s += 1;
    else s -= 2;                                // disclosed AND low: a real negative
  }
  if (c.carbs != null && !c.carbsUnreliable) {
    if (c.carbs < THRESHOLDS.carbs.good) s += 1;
    else if (c.carbs > THRESHOLDS.carbs.high) s -= 2;
  }
  if (c.taurineDisclosed) s += 1;

  return s;
}

// ── Verdict ────────────────────────────────────────────────────────────────
export function decideVerdict(c) {
  if (!c.firstIngredient) {
    return { label: 'Not transparent enough', judgeable: false, cap: 'no-ingredients' };
  }
  // Generic, un-named protein ("meat and animal derivatives") is a hard floor.
  if (c.genericProtein) return { label: 'Caution', judgeable: true, cap: null };

  const score = qualityScore(c);
  const carbsKnown = c.carbs != null && !c.carbsUnreliable;
  const proteinKnown = c.proteinDM != null;

  // Strong choice = a clean meat-first deck AND the numbers confirm it's excellent.
  // This is the only tier that requires disclosure, and it's a reward, not a gate
  // applied to everyone.
  const cleanDeck = c.meatFirst === true && !c.junk && !c.ingredientSplitting && c.grainFree !== false;
  const strong = cleanDeck &&
    proteinKnown && c.proteinDM >= THRESHOLDS.proteinDM.good &&
    carbsKnown && c.carbs < THRESHOLDS.carbs.good &&
    c.taurineDisclosed;
  if (strong) return { label: 'Strong choice', judgeable: true, cap: null };

  // Otherwise map the score to a tier. A clean meat-first deck (+3) clears "Good
  // choice" on its own, with or without numbers.
  let label;
  if (score >= 2) label = 'Good choice';
  else if (score >= 0) label = 'Okay for now';
  else if (score >= -3) label = 'Not ideal daily';
  else label = 'Caution';

  // Caps: things that should hold a food back regardless of other positives.
  if (c.meatFirst === false && TIER_RANK[label] > TIER_RANK['Not ideal daily']) label = 'Not ideal daily';
  if (c.junk && TIER_RANK[label] > TIER_RANK['Okay for now']) label = 'Okay for now';
  // A meat-first food still stacked with cereals (rice + corn + corn gluten, etc.)
  // is at best "Okay for now", however good its protein number looks.
  if (c.ingredientSplitting && TIER_RANK[label] > TIER_RANK['Okay for now']) label = 'Okay for now';

  // "Caution" is the harshest call. Reserve it for a label that's vague about its
  // meat (generic protein) or carries junk. A food that's merely plant-leading or
  // filler-heavy floors at "Not ideal daily" instead, so we never over-condemn,
  // and the Caution copy (about un-named meat) always matches the reason.
  if (label === 'Caution' && !c.genericProtein && !c.junk) label = 'Not ideal daily';

  return { label, judgeable: true, cap: c.gaConfidence === 'none' ? 'no-ga' : null };
}

function worryFor(label) {
  const filled = label === 'Strong choice' || label === 'Good choice' ? 1
    : label === 'Okay for now' || label === 'Not ideal daily' ? 2 : 3;
  const level = filled === 1 ? 'low' : filled === 2 ? 'medium' : 'high';
  const text = filled === 1 ? 'Low concern' : filled === 2 ? 'Medium concern' : 'Higher concern';
  return { level, filled, label: text };
}

// Transparency is its own surfaced axis (never the verdict). 'high' brands
// publish the full label; 'low' publish little beyond an ingredient list.
function transparencyOut(c) {
  const level = c.transparency || 'low';
  const label = level === 'high' ? 'High' : level === 'medium' ? 'Medium' : 'Low';
  const note = level === 'high'
    ? 'This brand publishes the full label, the ingredients and the guaranteed analysis.'
    : level === 'medium'
      ? 'This brand publishes part of the label. Some of the numbers are missing.'
      : 'This brand publishes very little. We are going on the ingredient list alone.';
  return { level, label, note };
}

// ── Plain (fallback) prose + reasons, all TRUE by construction ─────────────
function buildReasons(c, metrics) {
  const out = [];
  const first = metrics.find((m) => m.key === 'first');
  if (c.meatFirst === true) {
    out.push({ status: 'good', q: 'Named meat leads the label', a: `The first ingredient is ${c.firstIngredient}, a named animal protein.` });
  } else if (c.genericProtein) {
    out.push({ status: 'caution', q: 'Vague protein source', a: `The label leads with ${c.firstIngredient}, a generic protein rather than a named meat.` });
  } else if (c.meatFirst === false) {
    out.push({ status: 'caution', q: 'A plant leads the label', a: `The first ingredient is ${c.firstIngredient}, not a named meat.` });
  } else if (first.status === 'missing') {
    out.push({ status: 'missing', q: 'Ingredients not disclosed', a: 'We could not find a real ingredient list for this product.' });
  } else {
    out.push({ status: 'caution', q: 'Meat amount unclear', a: `${c.firstIngredient} leads the list, but the label does not make the amount clear.` });
  }

  if (c.proteinDM == null) {
    out.push({ status: 'missing', q: 'Protein not disclosed', a: 'The label we found has no guaranteed analysis, so we cannot confirm protein.' });
  } else if (c.proteinDM >= THRESHOLDS.proteinDM.good) {
    out.push({ status: 'good', q: 'Solid protein', a: `About ${c.proteinDM}% protein on a dry-matter basis${c.proteinDMEstimated ? ' (estimated)' : ''}.` });
  } else if (c.proteinDM < THRESHOLDS.proteinDM.acceptable) {
    out.push({ status: 'caution', q: 'Protein runs low', a: `Around ${c.proteinDM}% protein (dry matter), low for an obligate carnivore.` });
  }

  if (c.carbs != null && !c.carbsUnreliable && c.carbs >= THRESHOLDS.carbs.good) {
    out.push({ status: 'caution', q: 'Carbohydrates are high', a: `Estimated carbs are about ${c.carbs}%, above the 25% we like to see for cats.` });
  }
  if (c.grainFree === false) {
    out.push({ status: 'caution', q: 'Contains grain', a: 'The ingredient list includes grain. Cats do not need it, though it is not harmful in moderation.' });
  } else if (c.grainFree === true) {
    out.push({ status: 'good', q: 'Grain-free', a: 'No grains in the ingredient list.' });
  }
  if (!c.taurineDisclosed) {
    out.push({ status: 'missing', q: 'Taurine not listed', a: "Taurine matters for a cat's heart and eyes, and this label does not mention it." });
  }

  // "Why Sniff says this" explains the VERDICT, which is about quality. Real
  // negatives lead, then the good points. Disclosure gaps ('missing') are NOT
  // reasons for the verdict, they live in the transparency signal and the
  // "what they won't tell you" section, so they're dropped here.
  const negatives = out.filter((r) => r.status === 'caution' || r.status === 'bad');
  const goodOnes = out.filter((r) => r.status === 'good');
  return [...negatives, ...goodOnes].slice(0, 4);
}

function buildFits(c, label) {
  const fits = [];
  const noFit = [];
  if (label === 'Strong choice' || label === 'Good choice') fits.push('Healthy adult cats as a daily food');
  if (c.meatFirst === true) fits.push('Cats who do well on a meat-first recipe');
  if (c.grainFree === true) fits.push('Cats you are keeping off grains');
  if (c.grainFree === false) noFit.push('Cats you want fully off grains');
  if (c.carbs != null && !c.carbsUnreliable && c.carbs > THRESHOLDS.carbs.high) noFit.push('Cats who need a low-carb diet');
  if (c.gaConfidence === 'none') noFit.push('If you want the full guaranteed analysis confirmed');
  if (!fits.length) fits.push('As an option to consider alongside others');
  if (!noFit.length) noFit.push('Cats with a specific medical diet from your vet');
  return { fitsIf: fits.slice(0, 3), doesntFitIf: noFit.slice(0, 3) };
}

// Deterministic pet-parent voice, woven with each product's real facts. It can
// never contradict the label because it only references the computed values.
// Light variation (seeded by the first ingredient) keeps similar foods from
// reading identically.
function vary(seed, arr) {
  let h = 0;
  for (const ch of String(seed || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return arr[h % arr.length];
}

function plainSummary(c, label) {
  const ing = c.firstIngredient;
  if (label === 'Not transparent enough') {
    return c.firstIngredient
      ? "I can see what's in it, but the brand doesn't share the actual numbers, so I can't fully vouch for it."
      : "There's no real ingredient list to go on here, so I'm not going to slap a verdict on it and guess about your cat's food.";
  }
  if (label === 'Strong choice') {
    return vary(ing, [
      `This is the good stuff. It leads with ${ing}, keeps carbs near zero, and skips the grain. About as close to what a cat actually needs as you'll find on the shelf.`,
      `Genuinely strong. ${ing} up front, barely any carbs, no grain filler. This is what cat food is meant to look like.`,
    ]);
  }
  if (label === 'Good choice') {
    return vary(ing, [
      `A clean, honest bowl. It leads with ${ing}, a real named meat, and nothing on the label raises a flag. A solid everyday food.`,
      `This is a good one. ${ing} up front and a clean ingredient list. Exactly the kind of food a cat does well on.`,
    ]);
  }
  if (label === 'Okay for now') {
    const carbBit = (c.carbs != null && !c.carbsUnreliable && c.carbs >= 25) ? ` carbs sit a bit high (around ${c.carbs}%)` : '';
    const grainBit = c.grainFree === false ? `${carbBit ? ' and' : ''} there's some grain in the mix` : '';
    const splitBit = (!carbBit && !grainBit && c.ingredientSplitting) ? ' it leans on a fair bit of cereal filler' : '';
    const gap = (carbBit || grainBit) ? `, but${carbBit}${grainBit}.` : (splitBit ? `, but${splitBit}.` : ', but a few things hold it back.');
    return `Not bad, not amazing. It does start with ${ing}, which is what you want${gap} Fine for now if it suits your cat, though I'd keep half an eye out for something better.`;
  }
  if (label === 'Not ideal daily') {
    let why;
    if (c.meatFirst === false) why = `it leads with ${ing} instead of a named meat`;
    else if (c.proteinDM != null && c.proteinDM < THRESHOLDS.proteinDM.acceptable) why = `the protein's low for a cat (about ${c.proteinDM}% dry matter)`;
    else if (c.carbs != null && !c.carbsUnreliable && c.carbs > THRESHOLDS.carbs.high) why = `the carbs run high (around ${c.carbs}%)`;
    else why = 'it leans more on filler than a cat really needs';
    return `I wouldn't make this the everyday bowl. The catch is ${why}. Cats are built for meat, and this leans the other way.`;
  }
  if (label === 'Caution') {
    if (c.genericProtein) return `This is one I'd be wary of. It leads with "${ing}", a vague way of saying meat without naming it, which usually means there isn't much real meat in there.`;
    if (c.junk) return `This is one I'd be wary of. The label carries things a cat has no use for, like added colour or sugar. I'd rather feed something cleaner.`;
    return `This is one I'd be wary of. The recipe leans hard on filler instead of the meat a cat is built for.`;
  }
  return '';
}

function plainParentTake(c, label) {
  if (label === 'Strong choice') return "If my cat liked it, this would stay in the rotation. It's meat-first, easy on the carbs cats don't need, and the label is honest about what's inside.";
  if (label === 'Good choice') return "I'd feed this without losing sleep. It leads with real meat and keeps the ingredient list clean. A good everyday bowl.";
  if (label === 'Okay for now') return "It won't hurt a healthy cat, and if yours is happy on it, no panic. But if you can find something meatier with less grain, that's the better long-term bowl.";
  if (label === 'Not ideal daily') return "I'd keep this as a backup, not the daily bowl. Your cat would do better on something that leads with real meat and goes easier on the carbs.";
  if (label === 'Caution') return "Honestly, I'd pick something else. When a label won't even name the meat, I'd rather not guess what my cat is eating every day.";
  if (label === 'Not transparent enough') return "Until I can actually read the label, I'm not going to tell you this is fine. I'd rather be straight with you than make something up.";
  return '';
}

function plainAction(c, label) {
  if (label === 'Strong choice' || label === 'Good choice') return "Feed it as the daily bowl, and keep some water-rich wet food in the mix for hydration.";
  if (label === 'Okay for now') return "Fine to keep feeding, but compare it with a meatier, lower-carb option before you commit to the big bag.";
  if (label === 'Not ideal daily') return "Use it as a backup if you need to, and look for a meat-first option for everyday.";
  if (label === 'Caution') return "I'd swap this for a food that names its meat and shares its numbers.";
  if (label === 'Not transparent enough') return "Check the actual pack for the ingredients and analysis before buying, or send it to us and we'll verify it.";
  return '';
}

// Therapeutic diets and treats are not everyday meals; judging them by the
// meat-first/low-carb rubric would be misleading, so they get their own framing.
function scoreVetDiet(c) {
  return {
    rubricVersion: RUBRIC_VERSION,
    verdict: { label: 'Vet-directed diet', labelClass: 'vp-okay', tag: 'Therapeutic diet', summary: 'This is a therapeutic diet built for a specific medical condition. We do not score it against everyday-food standards. Feed it if, and only if, your vet has put your cat on it.' },
    worry: { level: 'low', filled: 1, label: 'Vet-directed', note: '' },
    metrics: buildMetrics(c),
    reasons: [
      { status: 'good', q: 'Built for a medical need', a: 'The recipe is intentionally different from regular food because it targets a health condition.' },
      { status: 'missing', q: 'Not an everyday food', a: 'Nutrient levels here are set for therapy, not for general feeding, so the usual meat-first scoring does not apply.' },
    ],
    fitsIf: ['Cats your vet has prescribed this for'],
    doesntFitIf: ['Healthy cats with no diagnosed condition', 'Everyday feeding without vet advice'],
    parentTake: 'If your vet prescribed this, feed it as directed and do not switch without asking them. If no one prescribed it, this is not the everyday food to reach for.',
    action: 'Use only under your vet\'s guidance.',
    transparency: transparencyOut(c),
    judgeable: true, cap: 'vet',
  };
}

function scoreTreat(c) {
  const reasons = [{ status: 'good', q: 'Fine as an occasional treat', a: 'Judged as an occasional treat rather than a meal, this is okay in small amounts.' }];
  if (c.treatJunk) reasons.push({ status: 'caution', q: 'Has added colours or sugar', a: 'The label includes colouring or sugar, which a cat does not need. Keep it to a rare treat.' });
  if (c.meatFirst === true) reasons.push({ status: 'good', q: 'Named meat leads', a: `It leads with ${c.firstIngredient}, a named animal protein.` });
  const filled = c.treatJunk ? 2 : 1;
  return {
    rubricVersion: RUBRIC_VERSION,
    verdict: { label: 'Treat, not a meal', labelClass: 'vp-okay', tag: 'Occasional treat', summary: `Treats are not meals. ${c.treatJunk ? 'This one has added colours or sugar, so keep it occasional.' : 'As an occasional treat this is fine.'} It should never replace proper food.` },
    worry: { level: filled === 2 ? 'medium' : 'low', filled, label: filled === 2 ? 'Medium concern' : 'Low concern', note: '' },
    metrics: buildMetrics(c),
    reasons: reasons.slice(0, 3),
    fitsIf: ['As an occasional treat or topper'],
    doesntFitIf: ['As a daily meal', 'Cats watching their weight'],
    parentTake: 'Treat it like candy, not dinner. A little now and then is fine; it should not replace proper food.',
    action: 'Give sparingly, alongside a proper diet.',
    transparency: transparencyOut(c),
    judgeable: true, cap: 'treat',
  };
}

// Main entry: computed facts -> complete deterministic analysis skeleton.
export function score(c) {
  if (c.dietType === 'vet') return scoreVetDiet(c);
  if (c.dietType === 'treat') return scoreTreat(c);
  const metrics = buildMetrics(c);
  const v = decideVerdict(c);
  const worry = worryFor(v.label);
  const reasons = buildReasons(c, metrics);
  const { fitsIf, doesntFitIf } = buildFits(c, v.label);
  return {
    rubricVersion: RUBRIC_VERSION,
    verdict: {
      label: v.label,
      labelClass: LABEL_CLASS[v.label] || 'vp-okay',
      tag: v.label === 'Not transparent enough' ? 'Label not verified' : (c.category ? `${c.category} food` : ''),
      summary: plainSummary(c, v.label),
    },
    worry: { ...worry, note: '' },
    metrics,
    reasons,
    fitsIf,
    doesntFitIf,
    parentTake: plainParentTake(c, v.label),
    action: plainAction(c, v.label),
    transparency: transparencyOut(c),
    judgeable: v.judgeable,
    cap: v.cap,
  };
}
