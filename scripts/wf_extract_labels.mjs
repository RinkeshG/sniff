export const meta = {
  name: 'extract-cat-labels',
  description: 'Fan out agents to extract grounded ingredient lists + guaranteed analysis from per-product evidence bundles',
  phases: [{ title: 'Extract', detail: 'one agent per product evidence bundle' }],
};

let slugs = args;
if (typeof slugs === 'string') { try { slugs = JSON.parse(slugs); } catch { slugs = slugs.split(/[\s,]+/).filter(Boolean); } }
if (slugs && !Array.isArray(slugs) && Array.isArray(slugs.slugs)) slugs = slugs.slugs;
if (!Array.isArray(slugs)) slugs = [];

// No slugs passed -> discover the to-do list (written to /tmp/slugs_todo.json).
if (!slugs.length) {
  const r = await agent('Use the Read tool on /tmp/slugs_todo.json — it is a JSON array of slug strings. Return it.', {
    label: 'list-bundles', phase: 'Extract',
    schema: { type: 'object', properties: { slugs: { type: 'array', items: { type: 'string' } } }, required: ['slugs'] },
  });
  slugs = (r && Array.isArray(r.slugs)) ? r.slugs : [];
}
log(`extracting ${slugs.length} evidence bundles (fan-out)`);

const PROMPT = (slug) => `You extract pet-food label facts from gathered web text. Use the Read tool on /tmp/evidence/${slug}.json. It contains everything scraped for ONE cat product from multiple retail sources; each source has a "description" (product-page text) and "packImageText" (OCR of pack photos, which may have OCR typos).

Find the product's REAL ingredient list and guaranteed analysis (GA), wherever they appear. They might be:
- a comma list ("Chicken, Rice, ...")
- a single ingredient ("Tuna")
- prose ("made with 75% Chicken Breast and pumpkin", "100% wild caught anchovies")
- inside the OCR'd pack text ("Ingredients: Tuna, Sunflower Oil... Guaranteed Analysis: Crude Protein (min) 10%...")

Rules:
- Use ONLY text present in the bundle. Quote ingredient names as written (you may fix an obvious OCR typo like "Ricc"->"Rice" ONLY if unambiguous). Never invent.
- Ignore marketing ("high quality", "human grade", "no fillers", "supports immunity", "100% natural").
- Trust the actual ingredient list over the flavour name. If a "Tuna" product's list leads with Chicken, the lead ingredient is Chicken.
- TREATS ONLY (check the bundle's "category" field == "treat"): if there is no formal ingredient list but the text clearly states the protein(s) the treat is made of ("real chicken and fish as the primary ingredient", "100% tuna", "made with whole shrimp"), use those named proteins as the ingredients. For MEALS (wet/dry food) do NOT infer ingredients from marketing — require an actual list.
- Pick the source with the clearest, most complete list; record which source URL you used.
- If NO real ingredient list exists anywhere in the bundle, return empty ingredients [].

Use the Write tool to save /tmp/extractions/${slug}.json with EXACTLY this JSON shape (no extra keys, valid JSON):
{"slug":"${slug}","ingredients":["Chicken","Rice"],"gaText":"Crude Protein 10% ... or null","sourceUrl":"https://... or null","leadIngredient":"Chicken or null","confident":true,"notes":"one line: where found, or why empty"}

Then reply with ONE short line: "${slug}: N ingredients" (or "${slug}: none").`;

await parallel(slugs.map((slug) => () => agent(PROMPT(slug), { label: `extract:${slug}`, phase: 'Extract' })));

log('extraction fan-out complete');
return { requested: slugs.length };
