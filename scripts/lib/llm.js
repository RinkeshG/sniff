// Thin Anthropic client + JSON helper, shared by extract.js and voice.js.
// Uses global fetch (Node 18+ / Vercel runtime). Model is overridable via env.

export const MODEL = process.env.SNIFF_MODEL || 'claude-sonnet-4-20250514';

export async function callClaude(prompt, { maxTokens = 1536, temperature = 0, model = MODEL } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, temperature, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.content?.[0]?.text || '';
}

// Pull the first JSON object out of a model response (tolerates stray prose/fences).
export function extractJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
