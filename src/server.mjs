// Stitch engine: holds the phone and the agent. Live event stream and task API for the studio UI.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { Registry } from './registry.mjs';
import { Agent } from './agent.mjs';
import { screenshot, handsAvailable, deviceInfo, tapAt, swipeAt, globalAction } from './adb.mjs';
import { model, provider, hasCredentials } from './llm.mjs';
import { serveStream } from './stream.mjs';

const PORT = Number(process.env.PORT || 4400);
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
    if (url.pathname === '/api/state') return json(res, 200, { ...agent.state(), model, hands: await handsAvailable(), provider, hasKey: hasCredentials });
    if (url.pathname === '/api/stream.mjpg') return serveStream(req, res);
    if (url.pathname === '/api/screen.png') {
      const png = await screenshot();
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(png);
    }
    if (req.method === 'POST' && url.pathname === '/api/task') {
      const { task } = await body(req);
      if (!task?.trim()) return json(res, 400, { error: 'Write a task first' });
      if (agent.busy) return json(res, 409, { error: 'Stitch is still working on the previous task' });
      agent.handle(task.trim());
      return json(res, 202, { ok: true });
    }
    const frame = url.pathname.match(/^\/api\/frame\/(\d+)\/(\d+)\.jpg$/);
    if (frame) {
      const jpg = await readFile(`runs/frames/${frame[1]}/${frame[2]}.jpg`).catch(() => null);
      if (!jpg) return json(res, 404, { error: 'no frame' });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' });
      return res.end(jpg);
    }
    if (url.pathname === '/api/device') return json(res, 200, await deviceInfo());
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
    if (req.method === 'POST' && url.pathname === '/api/approve') { await agent.approve((await body(req)).name); return json(res, 200, agent.state()); }
    if (req.method === 'POST' && url.pathname === '/api/break') { await agent.simulateUpdate((await body(req)).name); return json(res, 200, agent.state()); }

    return json(res, 404, { error: `not found. The studio UI runs at ${STUDIO_ORIGIN}` });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Stitch engine on http://localhost:${PORT}, studio at ${STUDIO_ORIGIN}`));
