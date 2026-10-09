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
// Exploring an app (the decisions while learning) may use a stronger model; it runs once per capability, reuse is free.
const EXPLORE_MODEL = process.env.LLM_EXPLORE_MODEL || MODEL;
const PRICES = {
  [MODEL]: [PRICE_IN, PRICE_OUT],
  [EXPLORE_MODEL]: EXPLORE_MODEL === MODEL ? [PRICE_IN, PRICE_OUT] : [Number(process.env.EXPLORE_PRICE_IN || 2), Number(process.env.EXPLORE_PRICE_OUT || 10)],
};

export const model = MODEL;
export const exploreModel = EXPLORE_MODEL;
export const provider = IS_OPENAI ? 'openai' : BASE;
export const hasCredentials = IS_OPENAI ? !!KEY : true;

// Hard caps per run, enforced before every model call: a run never makes more calls or spends more than this.
export const LIMITS = Object.freeze({
  calls: Number(process.env.MAX_CALLS_PER_RUN || 40),
  dollars: Number(process.env.MAX_SPEND_PER_RUN || 0.5),
});

export class CapError extends Error {}

export class Meter {
  constructor() { this.reset(); }
  // Throws before a call that the caps no longer allow; the run then stops with this reason.
  guard() {
    if (this.calls >= LIMITS.calls) throw new CapError(`Stopped at the cap of ${LIMITS.calls} model calls per run`);
    if (this.dollars >= LIMITS.dollars) throw new CapError(`Stopped at the cap of $${LIMITS.dollars.toFixed(2)} spend per run`);
  }
  reset() { this.calls = 0; this.tokensIn = 0; this.tokensOut = 0; this.dollars = 0; this.parts = {}; this.started = Date.now(); }
  // `purpose` splits the bill: "learning" (exploring an app, writing the program) or "planning" (splitting a request,
  // choosing a capability). Running a capability on the phone costs nothing, so it never appears here.
  add(usage, prompt, reply, model = MODEL, purpose = 'learning') {
    this.calls += 1;
    // Some local wrappers report no usage; estimate ~4 characters per token so the meter stays honest about scale.
    const tin = usage?.prompt_tokens || Math.ceil(prompt.length / 4);
    const tout = usage?.completion_tokens || Math.ceil(reply.length / 4);
    this.tokensIn += tin;
    this.tokensOut += tout;
    const [pin, pout] = PRICES[model] || [PRICE_IN, PRICE_OUT];
    const dollars = (tin * pin + tout * pout) / 1e6; // each call at its own model's price
    this.dollars += dollars;
    const part = (this.parts[purpose] ??= { calls: 0, cost: 0 });
    part.calls += 1;
    part.cost += dollars;
  }
  get cost() { return this.dollars; }
  snapshot() {
    return { calls: this.calls, tokensIn: this.tokensIn, tokensOut: this.tokensOut, cost: this.cost, parts: this.parts, ms: Date.now() - this.started };
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
  meter.guard();
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
  const data = await post(body);
  const text = data.choices?.[0]?.message?.content || '';
  if (/failed to authenticate|oauth session expired/i.test(text)) throw new Error(`Model provider: ${text}`);
  meter.add(data.usage, system + user, text);
  return extractJSON(text);
}

// A model call that never answers would freeze the agent (and its Stop button); give up after 45 s and retry once.
async function post(body) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Model ${res.status}: ${data?.error?.message || 'request failed'}`);
      return data;
    } catch (e) {
      lastErr = e.name === 'TimeoutError' ? new Error('The model did not answer within 45 s') : e;
    }
  }
  throw lastErr;
}

const noForcedTools = new Set();

// Forced tool call: the model must answer through one function with a JSON schema. Far stricter than "reply with JSON".
export async function askTool(meter, system, user, tool, { model = MODEL, purpose = 'learning' } = {}) {
  meter.guard();
  if (!hasCredentials) throw new Error('No API key. Set OPENAI_API_KEY in .env, or point LLM_BASE_URL at a local wrapper.');
  const body = {
    model,
    messages: [{ role: 'system', content: `${ROLE}\n\n${system}` }, { role: 'user', content: user }],
    tools: [{ type: 'function', function: tool }],
    tool_choice: noForcedTools.has(model) ? 'auto' : { type: 'function', function: { name: tool.name } },
  };
  if (noForcedTools.has(model)) body.messages[0].content += `\n\nAnswer only by calling the ${tool.name} function.`;
  if (IS_OPENAI && REASONING) body.reasoning_effort = REASONING;
  let data;
  try {
    data = await post(body);
  } catch (e) {
    // Some models (Sonnet with thinking) refuse a forced tool; ask again letting it choose, and remember that.
    if (!/tool_choice/i.test(e.message) || noForcedTools.has(model)) throw e;
    noForcedTools.add(model);
    return askTool(meter, system, user, tool, { model, purpose });
  }
  const msg = data.choices?.[0]?.message || {};
  const args = msg.tool_calls?.[0]?.function?.arguments;
  meter.add(data.usage, system + user, args || msg.content || '', model, purpose);
  if (args) return typeof args === 'string' ? JSON.parse(args) : args;
  return extractJSON(msg.content || ''); // a provider without tool support still gets a chance
}
