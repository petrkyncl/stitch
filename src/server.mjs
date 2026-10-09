// Stitch engine: holds the phone and the agent. Live event stream and task API for the studio UI.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { Registry } from './registry.mjs';
import { Agent } from './agent.mjs';
import { screenshot, handsAvailable, deviceInfo, tapAt, swipeAt, globalAction, installedApps, appIcon, getLiveBoxes, setLiveBoxes } from './adb.mjs';
import { model, exploreModel, provider, hasCredentials } from './llm.mjs';
import { serveStream } from './stream.mjs';

const PORT = Number(process.env.PORT || 4400);
const STARTED = Date.now();
const clients = new Set();

function emit(type, data) {
  const msg = `data: ${JSON.stringify({ type, at: Date.now(), ...data })}\n\n`;
  for (const res of clients) res.write(msg);
}

const registry = await new Registry().load();
const agent = await new Agent(registry, emit).loadHistory();

async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const STUDIO_ORIGIN = process.env.STUDIO_ORIGIN || 'http://localhost:3400';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', STUDIO_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': hello\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/state') return json(res, 200, { ...agent.state(), model, hands: await handsAvailable(), boxes: getLiveBoxes(), exploreModel, provider, hasKey: hasCredentials });
    if (url.pathname === '/api/stream.mjpg') return serveStream(req, res);
    if (url.pathname === '/api/screen.png') {
      const png = await screenshot();
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(png);
    }
    if (req.method === 'POST' && url.pathname === '/api/task') {
      const { task, app, capability, params } = await body(req);
      if (!task?.trim()) return json(res, 400, { error: 'Write a task first' });
      if (agent.busy) return json(res, 409, { error: 'Stitch is still working on the previous task' });
      const id = `${Date.now()}`;
      agent.handle(task.trim(), {
        app: typeof app === 'string' && /^[\w.]+$/.test(app) ? app : undefined,
        capability: typeof capability === 'string' ? capability : undefined,
        params: params && typeof params === 'object' ? Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) : undefined,
      });
      return json(res, 202, { ok: true, after: Number(id) - 1 }); // runs that start after this belong to this request
    }
    const frame = url.pathname.match(/^\/api\/frame\/(\d+)\/(\d+)\.jpg$/);
    if (frame) {
      const jpg = await readFile(`runs/frames/${frame[1]}/${frame[2]}.jpg`).catch(() => null);
      if (!jpg) return json(res, 404, { error: 'no frame' });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' });
      return res.end(jpg);
    }
    if (url.pathname === '/api/apps') {
      const apps = await installedApps();
      // The person's own apps first, then preinstalled ones, each alphabetical.
      return json(res, 200, [...apps].sort((a, b) => (a.system === b.system ? a.label.localeCompare(b.label) : a.system ? 1 : -1)));
    }
    const icon = url.pathname.match(/^\/api\/app-icon\/([\w.]+)$/);
    if (icon) {
      const png = await appIcon(icon[1]);
      if (!png) return json(res, 404, { error: 'no icon' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return res.end(png);
    }
    // `started` lets a viewer notice an engine restart and reopen its video.
    if (url.pathname === '/api/report') {
      const text = await report(url.searchParams.get('run'));
      return text ? json(res, 200, { text }) : json(res, 404, { error: 'No such run' });
    }
    if (url.pathname === '/api/device') return json(res, 200, { ...(await deviceInfo()), started: STARTED });
    if (req.method === 'POST' && url.pathname === '/api/input') {
      // Coordinates arrive normalized (0..1) from the video, so the studio never needs the phone's resolution.
      const b = await body(req);
      const dev = await deviceInfo();
      const W = dev.width || 1080, H = dev.height || 2340;
      if (b.type === 'tap') await tapAt(b.x * W, b.y * H);
      else if (b.type === 'swipe') await swipeAt(b.x1 * W, b.y1 * H, b.x2 * W, b.y2 * H, Math.min(Math.max(b.ms || 300, 80), 1500));
      else if (b.type === 'global') await globalAction(b.name);
      else return json(res, 400, { error: 'unknown input' });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') return json(res, 200, { stopping: agent.stop() });
    if (req.method === 'POST' && url.pathname === '/api/session') { await agent.newSession(); return json(res, 200, agent.state()); }
    if (req.method === 'POST' && url.pathname === '/api/permission') {
      const ok = agent.decide((await body(req)).decision);
      return json(res, ok ? 200 : 409, { ok, ...(ok ? {} : { error: 'Nothing is waiting for permission' }) });
    }
    if (req.method === 'POST' && url.pathname === '/api/overlay') return json(res, 200, { boxes: await setLiveBoxes((await body(req)).on) });
    if (req.method === 'POST' && url.pathname === '/api/revoke') { await agent.revoke((await body(req)).name); return json(res, 200, agent.state()); }
    if (req.method === 'POST' && url.pathname === '/api/approve') { await agent.approve((await body(req)).name); return json(res, 200, agent.state()); }
    if (req.method === 'POST' && url.pathname === '/api/break') { await agent.simulateUpdate((await body(req)).name); return json(res, 200, agent.state()); }

    return json(res, 404, { error: `not found. The studio UI runs at ${STUDIO_ORIGIN}` });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Stitch engine on http://localhost:${PORT}, studio at ${STUDIO_ORIGIN}`));

// The live video gets its own port: browsers allow only six open connections per host, and every studio tab already
// keeps the event stream open, so with a few tabs the video would wait forever on the shared port.
const STREAM_PORT = Number(process.env.STREAM_PORT || PORT + 1);
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (new URL(req.url, 'http://localhost').pathname === '/stream.mjpg') return serveStream(req, res);
  res.writeHead(404); res.end();
}).listen(STREAM_PORT, '127.0.0.1', () => console.log(`Stitch video on http://127.0.0.1:${STREAM_PORT}/stream.mjpg`));

// Everything needed to work out afterwards why a run went wrong, as one text: the run and its steps with times, the
// capability it used or built, the model's raw decisions during it, the screen now, models and code version.
// Also saved to runs/reports/<run>.md, so it can be read from disk instead of pasted.
async function report(id) {
  const r = agent.runs.find(x => x.id === id) || (agent.current?.id === id ? agent.current : null);
  if (!r) return null;
  const { readFile, writeFile, mkdir } = await import('node:fs/promises');
  const { execFileSync } = await import('node:child_process');
  const end = r.at + (r.ms || Date.now() - r.at) + 5000;
  const t = at => new Date(at).toTimeString().slice(0, 8) + '.' + String(at % 1000).padStart(3, '0');
  const decisions = (await readFile('runs/decisions.jsonl', 'utf8').catch(() => '')).split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(d => d?.at >= r.at - 1000 && d.at <= end);
  const capName = r.capability?.split(' + ').at(-1)?.split(' ')[0];
  const cap = capName ? await readFile(`registry/${capName}/capability.json`, 'utf8').catch(() => '') : '';
  let screen = '';
  try { const { compact } = await import('./ui.mjs'); const { observe } = await import('./adb.mjs'); const o = await observe(); screen = `${o.pkg}\n${compact(o.nodes)}`; } catch (e) { screen = `could not read: ${e.message}`; }
  let commit = '';
  try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
  const text = [
    `# Stitch report ${r.id}`,
    `request: ${r.task}`,
    `when: ${new Date(r.at).toISOString()}  session ${r.session}  app ${r.app || 'any'}`,
    `result: ${r.path || 'running'} ok=${!!r.ok}${r.error ? `  error: ${r.error}` : ''}`,
    `capability: ${r.capability || '-'}  calls ${r.calls ?? 0}  tokens ${(r.tokensIn ?? 0) + (r.tokensOut ?? 0)}  cost $${(r.cost ?? 0).toFixed(4)}  ${((r.ms ?? 0) / 1000).toFixed(1)} s`,
    `models: ${model} / learning ${exploreModel}  code ${commit}`,
    '', '## Steps',
    ...r.events.map((e, i) => `${t(e.at)} +${e.at - (r.events[i - 1]?.at ?? r.at)}ms ${e.type}${e.kind ? `/${e.kind}` : ''}: ${e.text || ''}${e.why ? `  (why: ${e.why})` : ''}`),
    '', `## Model decisions (${decisions.length})`,
    ...decisions.map(d => `${t(d.at)} ${JSON.stringify({ ...d, at: undefined })}`),
    '', `## Capability ${capName || '-'}`, cap || '(none)',
    '', '## Screen now', screen,
  ].join('\n');
  await mkdir('runs/reports', { recursive: true });
  await writeFile(`runs/reports/${r.id}.md`, text);
  return text;
}
