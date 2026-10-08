// Local studio: web UI, live event stream, task API.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Registry } from './registry.mjs';
import { Agent } from './agent.mjs';
import { screenshot, handsAvailable } from './adb.mjs';
import { model } from './llm.mjs';

const PORT = Number(process.env.PORT || 4400);
const PUBLIC = path.resolve('public');
const clients = new Set();

function emit(type, data) {
  const msg = `data: ${JSON.stringify({ type, at: Date.now(), ...data })}\n\n`;
  for (const res of clients) res.write(msg);
}

const registry = await new Registry().load();
const agent = new Agent(registry, emit);

async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': hello\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/state') return json(res, 200, { ...agent.state(), model, hands: await handsAvailable(), hasKey: !!process.env.OPENAI_API_KEY });
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
    if (req.method === 'POST' && url.pathname === '/api/session') { await agent.newSession(); return json(res, 200, agent.state()); }
    if (req.method === 'POST' && url.pathname === '/api/approve') { await agent.approve((await body(req)).name); return json(res, 200, agent.state()); }
    if (req.method === 'POST' && url.pathname === '/api/break') { await agent.simulateUpdate((await body(req)).name); return json(res, 200, agent.state()); }

    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const full = path.join(PUBLIC, path.normalize(file));
    if (!full.startsWith(PUBLIC)) return json(res, 404, { error: 'not found' });
    const content = await readFile(full);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
    res.end(content);
  } catch (e) {
    if (e.code === 'ENOENT') return json(res, 404, { error: 'not found' });
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Stitch studio on http://localhost:${PORT}`));
