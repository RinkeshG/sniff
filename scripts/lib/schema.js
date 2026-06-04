// Assemble the final `analysis` object in the exact shape the frontend reads
// (verdict, worry, action, reasons[], fitsIf, doesntFitIf, parentTake, metrics[]),
// merge in the warmer voice prose when provided, and sanitize all text.

// Hard rule: no em-dashes ever leave this function. Also straighten smart quotes
// and collapse whitespace so copy stays plain.
export function clean(s) {
  if (s == null) return s;
  return String(s)
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function metricOut(m) {
  return { name: m.name, value: clean(m.value), status: m.status, target: clean(m.target), statusLabel: clean(m.statusLabel) };
}

// skeleton: output of rubric.score(). voice: optional {summary,tag,parentTake,
// action,note,fitsIf[],doesntFitIf[],reasons[{q,a}]} already lint-passed.
// provenance: {source, sourceUrl, checkedAt, completeness}.
export function assemble(skeleton, voice, provenance) {
  const a = JSON.parse(JSON.stringify(skeleton));

  if (voice) {
    if (voice.summary) a.verdict.summary = voice.summary;
    if (voice.tag) a.verdict.tag = voice.tag;
    if (voice.parentTake) a.parentTake = voice.parentTake;
    if (voice.action) a.action = voice.action;
    if (voice.note) a.worry.note = voice.note;
    if (Array.isArray(voice.fitsIf) && voice.fitsIf.length) a.fitsIf = voice.fitsIf;
    if (Array.isArray(voice.doesntFitIf) && voice.doesntFitIf.length) a.doesntFitIf = voice.doesntFitIf;
    if (Array.isArray(voice.reasons) && voice.reasons.length === a.reasons.length) {
      a.reasons = a.reasons.map((r, i) => ({ status: r.status, q: voice.reasons[i].q || r.q, a: voice.reasons[i].a || r.a }));
    }
  }

  const out = {
    type: 'cat',
    rubricVersion: a.rubricVersion,
    verdict: { label: clean(a.verdict.label), tag: clean(a.verdict.tag), summary: clean(a.verdict.summary), labelClass: a.verdict.labelClass },
    worry: { level: a.worry.level, filled: a.worry.filled, label: clean(a.worry.label), note: clean(a.worry.note) },
    action: clean(a.action),
    reasons: a.reasons.map((r) => ({ status: r.status, q: clean(r.q), a: clean(r.a) })),
    fitsIf: a.fitsIf.map(clean),
    doesntFitIf: a.doesntFitIf.map(clean),
    parentTake: clean(a.parentTake),
    metrics: a.metrics.map(metricOut),
  };
  if (provenance) out.provenance = provenance;
  return out;
}

// The honest "we could not verify this label" payload, shown when no real source
// was found. Still a valid analysis object so the frontend renders gracefully.
export function abstainAnalysis(meta = {}, provenance) {
  const nd = (name, target) => ({ name, value: 'Not disclosed', status: 'missing', target, statusLabel: 'Not disclosed' });
  return {
    type: 'cat',
    unverified: true,
    rubricVersion: provenance?.rubricVersion || null,
    verdict: {
      label: 'Not verified yet',
      tag: 'Label not found',
      summary: clean('We could not find a real ingredient list or guaranteed analysis for this product yet, so we are not giving it a verdict. We would rather say that than guess.'),
      labelClass: 'vp-unknown',
    },
    worry: { level: 'low', filled: 0, label: 'Not verified yet', note: '' },
    action: clean('Check the physical pack for the ingredient list and guaranteed analysis. If you can share it, we will verify this product.'),
    reasons: [{ status: 'missing', q: 'No verified label', a: 'We have not been able to confirm this product from a real label source.' }],
    fitsIf: [],
    doesntFitIf: [],
    parentTake: clean('Until we can read the actual label, we cannot tell you with conviction whether this is right for your cat. We are working on it.'),
    metrics: [
      nd('First ingredient', 'Should be a named meat'),
      nd('Protein', 'Dry matter; good 40%+'),
      nd('Carbs', 'Estimated; good under 25%'),
      nd('Taurine (heart & eyes)', 'Should be listed'),
    ],
    ...(provenance ? { provenance } : {}),
  };
}
