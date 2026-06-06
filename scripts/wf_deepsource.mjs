export const meta = {
  name: 'deep-source-extract',
  description: 'For each still-unverified cat product, find the brand official site via web search, fetch the ingredient list, enrich the evidence bundle, and extract grounded facts',
  phases: [{ title: 'DeepExtract', detail: 'one agent per product: web search -> brand site -> extract' }],
};

let slugs = args && args.slugs;
if (!Array.isArray(slugs)) {
  const r = await agent('Use the Read tool on /tmp/slugs_deep.json — it is a JSON array of slug strings. Return it.', {
    label: 'list', phase: 'DeepExtract',
    schema: { type: 'object', properties: { slugs: { type: 'array', items: { type: 'string' } } }, required: ['slugs'] },
  });
  slugs = (r && Array.isArray(r.slugs)) ? r.slugs : [];
}
log(`deep-source extraction for ${slugs.length} products (brand site + web)`);

const PROMPT = (slug) => `Find ONE cat product's REAL ingredient list + guaranteed analysis from the best web source, and record it.

1. Read /tmp/evidence/${slug}.json (Read tool). Note its brand, title, category. Its existing "sources" (Supertails / Pet Project) did NOT yield a usable list.
2. Find the BRAND'S OWN official product page for THIS exact product via WebSearch (query like "<brand> <title> cat food ingredients"). Prefer the official brand domain. Hints: Sheba->sheba.in, Whiskas->whiskas.in, Me-O->meo/perfectcompanion, Drools->drools.in, Farmina N&D->farmina.com (in/eshop), Pro Plan/Purina->purina.in, Royal Canin->royalcanin India, Inaba->inaba-petfood, Bellotta->bellotta, Temptations->temptationstreats, Applaws->applaws.com, Schesir->schesir.com, Signature->signature, Carniwel/Petstar/Hachi/Purepet are Indian brands.
3. Fetch that page and read its INGREDIENTS and Guaranteed Analysis / nutritional info. IMPORTANT: many brand sites (e.g. sheba.in, whiskas.in, purina.in) are JavaScript-rendered and WebFetch returns almost nothing — when WebFetch is thin, use the firecrawl scrape skill (or run \`firecrawl scrape "<url>"\` via Bash) to get the rendered text. ALSO try pawdiet.com (search "pawdiet <brand> <product>") — it reliably lists the full ingredient list + guaranteed analysis for most pet foods. Be persistent: try the brand site AND pawdiet AND one retailer before giving up.
4. GROUNDING (required): append the page text you used so the extraction is verifiable. Read /tmp/evidence/${slug}.json again, add to its "sources" array a new object {"source":"web","url":"<page url>","description":"<paste the relevant page text INCLUDING the full ingredient list and GA, verbatim>","packImageText":""}, and Write the file back (valid JSON, keep existing keys/sources).
5. Write /tmp/extractions/${slug}.json (Write tool, OVERWRITE) with EXACTLY this shape:
{"slug":"${slug}","ingredients":["Chicken","Corn"],"gaText":"Crude Protein 30% ... or null","sourceUrl":"<page url or null>","leadIngredient":"Chicken or null","confident":true,"notes":"source used, or why empty"}

Rules: use ONLY text from a real page you actually fetched; quote ingredient names verbatim; trust the actual list over the flavour name; for TREATS with no formal list you may use the stated protein(s). If after these sources there is genuinely no ingredient list anywhere, write ingredients [].

Reply ONE short line: "${slug}: N ingredients (source domain)".`;

await parallel(slugs.map((slug) => () => agent(PROMPT(slug), { label: `deep:${slug}`, phase: 'DeepExtract', agentType: 'general-purpose' })));
log('deep extraction complete');
return { requested: slugs.length };
