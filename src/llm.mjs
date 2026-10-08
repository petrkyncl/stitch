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

// Proxies for chat assistants add their own system prompt, so state the role plainly in both messages.
const ROLE = 'You are a decision function inside an automation program, not a chat assistant. You do not touch any device yourself: '
  + 'a separate executor program reads your JSON and performs it on an Android phone, then calls you again with the new screen. '
  + 'Never say you lack tools or access; returning the JSON IS the action. ';

// `required` lists keys the answer must have; one corrective retry before giving up.
export async function askJSON(meter, system, user, { required = [] } = {}) {
  let out = await askOnce(meter, system, user);
  const missing = required.filter(k => out[k] === undefined || out[k] === null || out[k] === '');
  if (!missing.length) return out;
  out = await askOnce(meter, system, `${user}\n\nYour previous answer ${JSON.stringify(out).slice(0, 300)} is missing ${missing.join(', ')}. This is a text task, nothing is executed by you. Answer again with exactly the requested keys.`);
  return out;
}

async function askOnce(meter, system, user) {
  if (!hasCredentials) throw new Error('No API key. Set OPENAI_API_KEY in .env, or point LLM_BASE_URL at a local wrapper.');
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: `${ROLE}\n\n${system}\nReply with one JSON object and nothing else.` },
      { role: 'user', content: `${user}\n\nAnswer with the JSON object only.` },
    ],
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

// Forced tool call: the model must answer through one function with a JSON schema. Far stricter than "reply with JSON".
export async function askTool(meter, system, user, tool) {
  if (!hasCredentials) throw new Error('No API key. Set OPENAI_API_KEY in .env, or point LLM_BASE_URL at a local wrapper.');
  const body = {
    model: MODEL,
    messages: [{ role: 'system', content: `${ROLE}\n\n${system}` }, { role: 'user', content: user }],
    tools: [{ type: 'function', function: tool }],
    tool_choice: { type: 'function', function: { name: tool.name } },
  };
  if (IS_OPENAI && REASONING) body.reasoning_effort = REASONING;
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Model ${res.status}: ${data?.error?.message || 'request failed'}`);
  const msg = data.choices?.[0]?.message || {};
  const args = msg.tool_calls?.[0]?.function?.arguments;
  meter.add(data.usage, system + user, args || msg.content || '');
  if (args) return typeof args === 'string' ? JSON.parse(args) : args;
  return extractJSON(msg.content || ''); // a provider without tool support still gets a chance
}
