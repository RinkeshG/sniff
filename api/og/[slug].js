// /og/<slug> — 1200x630 PNG OG card.
// Direction B: Sniff is the hero, product appears as a "latest read" footnote.
// Pairs with share copy like "Just looked up X on Sniff — try yours: <url>"

import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

const SUPABASE_URL = 'https://hjscicnzlplxpgxzvdex.supabase.co';
const SUPABASE_KEY = 'sb_publishable_q8CsjF6ub7apLI79mzsc2Q_Hg7-T2IA';

// Brand palette (matches site CSS vars)
const CREAM = '#F5F0E5';
const CHARCOAL = '#2A2725';
const GINGER = '#E08A3A';
const INDIE = '#8B7355';
const INDIE_SOFT = '#B8A88E';

// Young Serif TTF — Google's font repo, mirrored on jsDelivr.
// Fetched once per edge instance and cached.
const YOUNG_SERIF_URL = 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/youngserif/YoungSerif-Regular.ttf';

let _fontPromise = null;
function loadYoungSerif() {
  if (!_fontPromise) {
    _fontPromise = fetch(YOUNG_SERIF_URL).then(r => {
      if (!r.ok) throw new Error('font fetch failed');
      return r.arrayBuffer();
    }).catch(() => null);
  }
  return _fontPromise;
}

async function fetchProduct(slug) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/products?slug=eq.${encodeURIComponent(slug)}&select=slug,brand,title&limit=1`;
    const r = await fetch(url, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows[0] || null;
  } catch {
    return null;
  }
}

// Strip " · Dry food" category suffix so the latest-read line reads naturally.
function cleanBrand(brand) {
  if (!brand) return '';
  return brand.split(/\s*[·•]\s*/)[0].trim();
}

function latestReadName(product) {
  if (!product) return null;
  const brand = cleanBrand(product.brand);
  const title = (product.title || '').trim();
  return [brand, title].filter(Boolean).join(' ') || null;
}

export default async function handler(req) {
  const { searchParams, pathname } = new URL(req.url);
  const slug = (searchParams.get('slug')
    || pathname.split('/').filter(Boolean).pop()
    || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 120);

  const [product, fontData] = await Promise.all([
    slug ? fetchProduct(slug) : Promise.resolve(null),
    loadYoungSerif(),
  ]);

  const latestRead = latestReadName(product);

  const fonts = fontData
    ? [{ name: 'Young Serif', data: fontData, weight: 400, style: 'normal' }]
    : undefined;

  return new ImageResponse(
    {
      type: 'div',
      props: {
        style: {
          width: '1200px',
          height: '630px',
          background: CREAM,
          padding: '80px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          fontFamily: 'sans-serif',
          color: CHARCOAL,
        },
        children: [
          // Top: Sniff· wordmark
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                alignItems: 'center',
                fontFamily: 'Young Serif, serif',
                fontSize: '36px',
                letterSpacing: '-0.01em',
                color: CHARCOAL,
              },
              children: [
                { type: 'span', props: { children: 'Sniff' } },
                {
                  type: 'span',
                  props: {
                    style: { color: GINGER, fontSize: '26px', marginLeft: '4px', marginBottom: '8px' },
                    children: '·',
                  },
                },
              ],
            },
          },

          // Center: hero question
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                flexWrap: 'wrap',
                fontFamily: 'Young Serif, serif',
                fontSize: '104px',
                lineHeight: 1.02,
                letterSpacing: '-0.025em',
                color: CHARCOAL,
                maxWidth: '1000px',
              },
              children: [
                { type: 'span', props: { children: "What's " } },
                { type: 'span', props: { style: { color: GINGER }, children: 'actually ' } },
                { type: 'span', props: { children: "in your cat's food?" } },
              ],
            },
          },

          // Footer: latest read + sniff.fyi
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-end',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: { display: 'flex', flexDirection: 'column', gap: '6px' },
                    children: latestRead
                      ? [
                          {
                            type: 'div',
                            props: {
                              style: {
                                fontSize: '13px',
                                letterSpacing: '0.22em',
                                textTransform: 'uppercase',
                                color: INDIE_SOFT,
                                fontWeight: 700,
                              },
                              children: 'Latest read',
                            },
                          },
                          {
                            type: 'div',
                            props: {
                              style: {
                                fontSize: '22px',
                                color: CHARCOAL,
                                fontWeight: 500,
                                maxWidth: '780px',
                                display: 'flex',
                              },
                              children: latestRead,
                            },
                          },
                        ]
                      : [
                          {
                            type: 'div',
                            props: {
                              style: {
                                fontSize: '18px',
                                color: INDIE,
                                fontWeight: 500,
                                display: 'flex',
                              },
                              children: 'Honest cat food checker · India',
                            },
                          },
                        ],
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: '22px',
                      color: CHARCOAL,
                      fontWeight: 600,
                      letterSpacing: '0.02em',
                      display: 'flex',
                    },
                    children: 'sniff.fyi',
                  },
                },
              ],
            },
          },
        ],
      },
    },
    {
      width: 1200,
      height: 630,
      fonts,
      headers: {
        'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800',
      },
    },
  );
}
