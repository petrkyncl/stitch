// OpenAI chat call that returns JSON, with a meter for calls, tokens and dollars.
const MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const REASONING = process.env.OPENAI_REASONING || '';
const PRICE_IN = Number(process.env.PRICE_IN || 0.25);
const PRICE_OUT = Number(process.env.PRICE_OUT || 2);

export class Meter {
  constructor() { this.reset(); }
  reset() { this.calls = 0; this.tokensIn = 0; this.tokensOut = 0; this.started = Date.now(); }
  add(usage) {
    this.calls += 1;
    this.tokensIn += usage?.prompt_tokens || 0;
    this.tokensOut += usage?.completion_tokens || 0;
  }
  get cost() { return (this.tokensIn * PRICE_IN + this.tokensOut * PRICE_OUT) / 1e6; }
  snapshot() {
    return { calls: this.calls, tokensIn: this.tokensIn, tokensOut: this.tokensOut, cost: this.cost, ms: Date.now() - this.started };
  }
}

export const model = MODEL;

export async function askJSON(meter, system, user) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set. Add it to .env and restart.');
  const body = {
    model: MODEL,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
  if (REASONING) body.reasoning_effort = REASONING;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${data?.error?.message || 'request failed'}`);
  meter.add(data.usage);
  const text = data.choices?.[0]?.message?.content || '{}';
  try { return JSON.parse(text); } catch { throw new Error('Model returned invalid JSON'); }
}
