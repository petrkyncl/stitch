// Chat call that returns JSON, with a meter for calls, tokens and dollars.
// Works with any OpenAI-compatible endpoint: the OpenAI API, or a local Claude wrapper such as claude-max-api-proxy.
const BASE = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
const MODEL = process.env.LLM_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini';
const REASONING = process.env.OPENAI_REASONING || '';
const IS_OPENAI = BASE.includes('api.openai.com');
// Priced at the provider's public API list price, so runs are comparable even on a subscription.
const PRICE_IN = Number(process.env.PRICE_IN || 0.25);
const PRICE_OUT = Number(process.env.PRICE_OUT || 2);

export const model = MODEL;
export const provider = IS_OPENAI ? 'openai' : BASE;
export const hasCredentials = IS_OPENAI ? !!KEY : true;

export class Meter {
  constructor() { this.reset(); }
  reset() { this.calls = 0; this.tokensIn = 0; this.tokensOut = 0; this.started = Date.now(); }
  add(usage, prompt, reply) {
    this.calls += 1;
    // Some local wrappers report no usage; estimate ~4 characters per token so the meter stays honest about scale.
    this.tokensIn += usage?.prompt_tokens || Math.ceil(prompt.length / 4);
    this.tokensOut += usage?.completion_tokens || Math.ceil(reply.length / 4);
  }
  get cost() { return (this.tokensIn * PRICE_IN + this.tokensOut * PRICE_OUT) / 1e6; }
  snapshot() {
    return { calls: this.calls, tokensIn: this.tokensIn, tokensOut: this.tokensOut, cost: this.cost, ms: Date.now() - this.started };
  }
}

function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`Model did not return JSON: ${text.slice(0, 160)}`);
  return JSON.parse(raw.slice(start, end + 1));
}

export async function askJSON(meter, system, user) {
  if (!hasCredentials) throw new Error('No API key. Set OPENAI_API_KEY in .env, or point LLM_BASE_URL at a local wrapper.');
  const body = {
    model: MODEL,
    messages: [{ role: 'system', content: `${system}\nReply with one JSON object and nothing else.` }, { role: 'user', content: user }],
  };
  if (IS_OPENAI) body.response_format = { type: 'json_object' };
  if (IS_OPENAI && REASONING) body.reasoning_effort = REASONING;
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Model ${res.status}: ${data?.error?.message || 'request failed'}`);
  const text = data.choices?.[0]?.message?.content || '';
  if (/failed to authenticate|oauth session expired/i.test(text)) throw new Error(`Model provider: ${text}`);
  meter.add(data.usage, system + user, text);
  return extractJSON(text);
}
