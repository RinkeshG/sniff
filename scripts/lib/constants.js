// Shared lexicons and patterns for the Sniff analysis pipeline.
// Pure data + tiny matchers. No I/O. Imported by compute, validate, rubric.

// Named animal proteins a cat actually wants to see first on a label.
// Order doesn't matter; matched as whole-word-ish, case-insensitive.
export const NAMED_MEATS = [
  'chicken', 'turkey', 'duck', 'goose', 'quail', 'poultry',
  'lamb', 'mutton', 'beef', 'pork', 'venison', 'boar', 'rabbit', 'kangaroo', 'horse',
  'salmon', 'tuna', 'mackerel', 'sardine', 'herring', 'trout', 'cod', 'pollock', 'pollack',
  'snapper', 'whitefish', 'anchovy', 'bonito', 'tilapia', 'catfish', 'sea bream', 'seabream',
  'crab', 'prawn', 'shrimp', 'mussel', 'clam', 'squid', 'surimi', 'krill', 'fish',
  'egg', 'liver', 'heart', 'gizzard', 'tripe',
];

// Qualifiers that still describe a real named-meat ingredient (not generic filler).
// e.g. "dehydrated chicken", "chicken meal", "fish protein", "dried salmon".
const MEAT_FORMS = '(?:fresh|dried|dehydrated|de-?hydrated|hydrol(?:y|i)zed|hydrolysed|raw|frozen|cooked|whole|deboned|boneless|meal|protein|fillet|flesh|broth|meat)';

// A named meat appears in the string (e.g. "Dehydrated chicken meat (36%)").
// Each lexicon entry also matches its plural: "+s/+es" for most, and "y -> ies"
// for y-endings, so "Sardines"/"Prawns"/"Anchovies"/"Crunchies"-free fish all
// read as named meats, not as "a plant leads". (anchovy -> anchovies was the miss
// that wrongly made HUFT single-ingredient anchovy treats look unverifiable.)
export const meatPluralAlt = (w) => (/y$/i.test(w) ? w.slice(0, -1) + '(?:y|ys|ies)' : w + '(?:e?s)?');
const NAMED_MEAT_RE = new RegExp(
  '\\b(?:' + MEAT_FORMS + '\\s+)*(?:' + NAMED_MEATS.map(meatPluralAlt).join('|') + ')\\b',
  'i'
);
export function hasNamedMeat(str) {
  return !!str && NAMED_MEAT_RE.test(String(str));
}

// Generic, un-named protein sources we always flag. "Chicken meal" is fine
// (named); "meat meal" / "animal derivatives" / "by-products" are not.
const GENERIC_PROTEIN_RE = new RegExp(
  [
    'animal\\s+derivatives',
    'meat\\s+and\\s+animal\\s+derivatives',
    'by[-\\s]?products?',
    'meat\\s+and\\s+bone\\s+meal',
    '\\bmeat\\s+meal\\b',
    '\\bmeat\\b(?!\\s*\\()', // bare "meat" not immediately qualified by a "(" percent
  ].join('|'),
  'i'
);
// By-products and "animal derivatives" are a quality concern even when a species
// is named ("chicken by-product meal" is not the same as "chicken meal").
const BYPRODUCT_RE = /by[-\s]?products?|animal derivatives|meat and bone meal/i;
export function isGenericProtein(str) {
  if (!str) return false;
  const s = String(str);
  if (BYPRODUCT_RE.test(s)) return true;
  // Otherwise, a named species makes it a real meat ("chicken meal", "dehydrated chicken").
  if (hasNamedMeat(s)) return false;
  return GENERIC_PROTEIN_RE.test(s);
}

// Grain / starchy-cereal tokens. Used ONLY against a complete ingredient list.
export const GRAIN_RE =
  /\b(rice|corn|maize|wheat|cereal|cereals|grain|grains|millet|barley|oat|oats|sorghum|soy|soya|soybean)\b/i;

// Water/jelly/broth carriers that legitimately lead a wet-food list but are not
// the meaningful "first ingredient" for judging meat content.
export const WET_CARRIER_RE = /\b(water|broth|stock|jelly|gravy|gelatin(?:e)?|aspic)\b/i;

// Tokens that must NEVER be accepted as a first ingredient. Backstop against the
// old title-token failure (brand names, life-stage words, stopwords, placeholders).
export const FIRST_ING_JUNK = new Set([
  // stopwords / fragments
  'this', 'that', 'and', 'the', 'with', 'in', 'of', 'for', 'a', 'an', 'or',
  // placeholder strings the old generator produced
  'varies', 'often cereals', 'check label', 'cereals likely', 'named meat', 'real',
  // section labels that must never be mistaken for an ingredient
  'composition', 'ingredients', 'ingredient',
  // title tokens seen in the bad data
  'ocean', 'kitten', 'skin', 'baby', 'urinary', 'hairball', 'special', 'creamy',
  'persian', 'sterilised', 'sterilized', 'neutered', 'adult', 'senior', 'mature',
  'indoor', 'outdoor', 'care', 'formula', 'premium', 'gold', 'plus', 'mix', 'duo',
  // brand tokens seen as first ingredients in the bad data
  'farmina', 'inaba', 'whiskas', 'sheba', 'drools', 'applaws', 'royal', 'canin',
  'me-o', 'meo', 'purepet', 'iams', 'orijen', 'acana', 'josera', 'reflex',
]);

// Completeness terminators: a real ingredient list usually ends near additives /
// minerals / vitamins. Used to decide a list isn't truncated mid-way.
export const LIST_TERMINATOR_RE =
  /(additives?|minerals?|vitamins?|preservatives?|antioxidants?|trace elements?|technological|nutritional additives|e\d{3})/i;

// Marketing phrases that must NOT be treated as label facts.
export const MARKETING_CLAIM_RE =
  /\b(grain[-\s]?free|high[-\s]?protein|complete|balanced|natural|premium|holistic|human[-\s]?grade|vet[-\s]?recommended|no\s+fillers)\b/i;
