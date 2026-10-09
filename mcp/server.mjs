#!/usr/bin/env node
// Stitch as an MCP server: another agent (Claude, ChatGPT, any MCP client) can use the phone through Stitch.
// Every capability Stitch has learned is a tool of its own, and the list grows while you work: when Stitch learns
// something new, connected clients are told and get the new tool. Anything that sends, pays or deletes still waits
// for the person in Stitch Studio, so authority never grows through this door either.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ENGINE = (process.env.STITCH_ENGINE || 'http://localhost:4400').replace(/\/$/, '');

const server = new McpServer(
  { name: 'stitch', title: 'Stitch phone agent', version: '0.1.0' },
  {
    instructions:
      'Stitch drives a real Android phone. Use a capability tool when one fits (it runs as learned code, with no model calls). ' +
      'Otherwise use phone_do with a plain request: Stitch then learns a new capability, which appears as a new tool. ' +
      'Sending, paying or deleting waits until the person approves it in Stitch Studio.',
  },
);

async function api(path, body) {
  const res = await fetch(ENGINE + path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Stitch engine answered ${res.status}`);
  return data;
}

// Start a request and wait for its run to finish (learning can take a minute; an approval waits for the person).
async function run(body) {
  const before = (await api('/api/state')).runs.length;
  await api('/api/task', body);
  const until = Date.now() + 8 * 60 * 1000;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 800));
    const s = await api('/api/state');
    if (!s.busy && s.runs.length > before) return s.runs.at(-1);
  }
  throw new Error('Stitch did not finish within 8 minutes');
}

const OUTCOME = {
  learned: 'Done. Stitch learned a new capability for this and installed it.',
  code: 'Done, as learned code with no model calls.',
  repaired: 'Done. The app had changed; Stitch repaired its capability and installed the new version.',
  held: 'Not done: the person did not allow this in Stitch Studio. Nothing was sent.',
  stopped: 'Stopped by the person.',
  failed: 'Not done.',
};

function result(r) {
  const lines = [OUTCOME[r.path] || OUTCOME.failed];
  const proof = [...r.events].reverse().find(e => e.type === 'done');
  if (proof) lines.push(proof.text);
  if (r.error) lines.push(`Reason: ${r.error}`);
  if (r.reply) lines.push('', 'The app answered:', r.reply);
  if (r.data?.length) {
    const cols = Object.keys(r.data[0]);
    lines.push('', `| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`, ...r.data.map(row => `| ${cols.map(c => row[c] ?? '').join(' | ')} |`));
  }
  lines.push('', `${((r.ms || 0) / 1000).toFixed(1)} s, ${r.calls || 0} model calls, $${(r.cost || 0).toFixed(4)}${r.capability ? `, capability ${r.capability}` : ''}`);
  return { content: [{ type: 'text', text: lines.join('\n') }], isError: !r.ok };
}

const failure = e => ({ content: [{ type: 'text', text: e.message }], isError: true });

server.registerTool('phone_do', {
  title: 'Do something on the phone',
  description: 'Ask Stitch, in plain words, to do something on the Android phone, e.g. "Set an alarm for 7:14" or ' +
    '"Get 10 pizza places from Google Maps with rating". If no capability fits yet, Stitch explores the app and learns one ' +
    '(20 to 60 seconds); after that it is a tool of its own.',
  inputSchema: {
    task: z.string().describe('The request, as you would say it to a person holding the phone'),
    app: z.string().optional().describe('Package of the app to use, if you know it'),
  },
}, async ({ task, app }) => {
  try { return result(await run({ task, app })); } catch (e) { return failure(e); }
});

// One tool per learned capability, kept in step with the engine's registry.
const tools = new Map(); // tool name -> { handle, version }
const toolName = name => name.replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 64);

function capabilityTool(c) {
  const shape = {};
  for (const p of c.paramInfo || []) {
    const d = [p.description, p.example ? `e.g. ${p.example}` : ''].filter(Boolean).join(', ');
    shape[p.name] = p.default !== undefined ? z.string().optional().describe(`${d} (default ${p.default})`) : z.string().describe(d);
  }
  const asks = c.effect === 'external' && !c.approved
    ? ' It sends something, so it waits until the person allows it in Stitch Studio.'
    : '';
  return server.registerTool(toolName(c.name), {
    title: c.title,
    description: `${c.description} Runs on the phone as learned code, no model calls.${asks}`,
    inputSchema: shape,
  }, async params => {
    const values = Object.entries(params).filter(([, v]) => v !== undefined);
    const task = `${c.title}${values.length ? ` (${values.map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(', ')})` : ''}`;
    try { return result(await run({ task, capability: c.name, params: Object.fromEntries(values) })); } catch (e) { return failure(e); }
  });
}

async function sync() {
  let caps;
  try { caps = (await api('/api/state')).capabilities || []; } catch { return; } // engine not up yet
  const seen = new Set();
  for (const c of caps) {
    const name = toolName(c.name);
    seen.add(name);
    const key = `${c.version}:${c.approved}:${c.status}`;
    const known = tools.get(name);
    if (known?.key === key) continue;
    known?.handle.remove();
    tools.set(name, { handle: capabilityTool(c), key });
  }
  for (const [name, t] of tools) if (!seen.has(name)) { t.handle.remove(); tools.delete(name); }
}

await sync();
await server.connect(new StdioServerTransport());
setInterval(sync, 4000); // new capabilities become new tools; the client hears about it through list_changed
