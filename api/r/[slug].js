// /r/<slug> — shareable URL with proper OG meta.
// Crawlers (WhatsApp, iMessage, Twitter, Slack) read the meta tags;
// humans get redirected to https://sniff.fyi/#<slug>.

const SUPABASE_URL = 'https://hjscicnzlplxpgxzvdex.supabase.co';
const SUPABASE_KEY = 'sb_publishable_q8CsjF6ub7apLI79mzsc2Q_Hg7-T2IA';
const SITE_URL = 'https://sniff.fyi';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

async function fetchProduct(slug) {
  const url = `${SUPABASE_URL}/rest/v1/products?slug=eq.${encodeURIComponent(slug)}&select=slug,brand,title,analysis&limit=1`;
  const r = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

function logOpen(slug, req) {
  // fire-and-forget — never block the response
  try {
    fetch(`${SUPABASE_URL}/rest/v1/share_events`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        event_type: 'share_opened',
        product_slug: slug,
        share_method: 'link',
        referrer: (req.headers.referer || req.headers.referrer || '').slice(0, 1000) || null,
        user_agent: (req.headers['user-agent'] || '').slice(0, 500) || null,
      }),
    }).catch(() => {});
  } catch {}
}

function fallbackHtml(slug) {
  const url = `${SITE_URL}/#${esc(slug)}`;
  return `<!doctype html><html><head>
<meta charset="utf-8">
<title>Sniff — honest cat food checker for India</title>
<meta name="description" content="Sniff reads the label and tells you if the cat food is actually good. Made for India.">
<meta property="og:site_name" content="Sniff">
<meta property="og:title" content="Sniff — honest cat food checker for India">
<meta property="og:description" content="Reads the label and tells you if the food is actually good.">
<meta property="og:image" content="${SITE_URL}/og-image.png">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0; url=${url}">
</head><body><p>Loading… <a href="${url}">Open Sniff</a></p>
<script>location.replace(${JSON.stringify(url)});</script>
</body></html>`;
}

function productHtml(product, slug) {
  const a = product.analysis || {};
  const v = a.verdict || {};
  const brand = product.brand || 'Sniff';
  const title = product.title || '';
  const fullName = [brand, title].filter(Boolean).join(' — ');
  const verdictLabel = (v.label || '').replace(/\.$/, '');
  const summary = v.summary || a.parentTake || 'Honest cat food analysis from Sniff.';

  const ogTitle = verdictLabel
    ? `${fullName} — ${verdictLabel}`
    : `${fullName} on Sniff`;
  const ogDesc = summary.length > 200 ? summary.slice(0, 197) + '…' : summary;

  const shareUrl = `${SITE_URL}/r/${esc(slug)}`;
  const appUrl = `${SITE_URL}/#${esc(slug)}`;
  const ogImage = `${SITE_URL}/og/${esc(slug)}`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(ogTitle)} · Sniff</title>
<meta name="description" content="${esc(ogDesc)}">
<link rel="canonical" href="${shareUrl}">

<meta property="og:type" content="article">
<meta property="og:site_name" content="Sniff">
<meta property="og:title" content="${esc(ogTitle)}">
<meta property="og:description" content="${esc(ogDesc)}">
<meta property="og:image" content="${ogImage}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${shareUrl}">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(ogTitle)}">
<meta name="twitter:description" content="${esc(ogDesc)}">
<meta name="twitter:image" content="${ogImage}">

<meta http-equiv="refresh" content="0; url=${appUrl}">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; background: #FAF7F1; color: #2B231D; text-align: center; padding: 80px 24px; margin: 0; }
  h1 { font-family: Georgia, serif; font-size: 28px; margin: 0 0 8px; }
  p { color: #8B7355; }
  a { color: #D97706; text-decoration: none; }
</style>
</head>
<body>
  <h1>Sniff</h1>
  <p>Opening report…</p>
  <p><a href="${appUrl}">Tap here if it doesn't load</a></p>
  <script>location.replace(${JSON.stringify(appUrl)});</script>
</body></html>`;
}

export default async function handler(req, res) {
  const slug = (req.query?.slug || '').toString().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 120);

  if (!slug) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(404).send(fallbackHtml(''));
  }

  // fire-and-forget analytics
  logOpen(slug, req);

  let product = null;
  try {
    product = await fetchProduct(slug);
  } catch (err) {
    // network/db error — still serve a graceful fallback
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Crawlers cache OG for ~1 day; humans redirect immediately so cache is fine.
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');

  if (!product) {
    return res.status(200).send(fallbackHtml(slug));
  }
  return res.status(200).send(productHtml(product, slug));
}
