// The Frankenstein loop: find a capability or notice the gap, build it, test it, install it, reuse it, repair it.
import { Meter, askJSON } from './llm.mjs';
import { explore } from './explorer.mjs';
import { compile } from './compiler.mjs';
import { run } from './runner.mjs';
import { review, GRANTED } from './policy.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { titleFrom } from './registry.mjs';
import { latestFrame } from './stream.mjs';

const FRAME_KINDS = new Set(['explore', 'run', 'held', 'done', 'broken', 'blocked', 'test', 'ask']);

const HISTORY = 'runs/history.json';

class StoppedError extends Error {
  constructor() { super('Stopped by you'); }
}

export class Agent {
  constructor(registry, emit) {
    this.registry = registry;
    this.emit = emit;
    this.session = 1;
    this.runs = [];
    this.busy = false;
  }

  // Runs survive an engine restart, so the studio keeps its chat and the learning-vs-reuse numbers.
  async loadHistory() {
    try {
      const saved = JSON.parse(await readFile(HISTORY, 'utf8'));
      this.runs = saved.runs || [];
      this.session = saved.session || 1;
    } catch { /* first start */ }
    return this;
  }

  async saveHistory() {
    await mkdir('runs', { recursive: true });
    await writeFile(HISTORY, JSON.stringify({ session: this.session, runs: this.runs.slice(-200) }, null, 1));
  }

  async newSession() {
    this.session += 1;
    await this.registry.load(); // nothing carries over except what is on disk
    await this.saveHistory();
    this.emit('session', { session: this.session, capabilities: this.registry.all().length });
  }

  // `app` (optional) is the package the person chose; it narrows routing and skips guessing the app.
  async handle(task, { app } = {}) {
    if (this.busy) throw new Error('Stitch is already working on a task');
    this.busy = true;
    const meter = new Meter();
    const record = { id: `${Date.now()}`, session: this.session, task, app, at: Date.now(), events: [] };
    this.current = record;
    let frames = 0;
    this.stopRequested = false;
    const emit = (type, data = {}) => {
      // Every step reports progress through here before it acts, so a stop lands before the next action.
      if (this.stopRequested && !['error', 'run', 'stopped', 'blocked'].includes(type)) throw new StoppedError();
      // Keep what the phone showed at this step, straight from the live video, so the chat can replay the run.
      let frame;
      const jpg = latestFrame();
      if (jpg && FRAME_KINDS.has(data.kind || type)) {
        const n = frames++;
        frame = `/api/frame/${record.id}/${n}.jpg`;
        mkdir(`runs/frames/${record.id}`, { recursive: true }).then(() => writeFile(`runs/frames/${record.id}/${n}.jpg`, jpg)).catch(() => {});
      }
      if (type !== 'task') record.events.push({ type, kind: data.kind, text: data.text, why: data.why, frame, at: Date.now() });
      this.emit(type, { ...data, frame, runId: record.id, meter: meter.snapshot() });
    };
    emit('task', { task, session: this.session, id: record.id });
    try {
      const found = await this.route(task, meter, emit, app);
      if (found) {
        Object.assign(record, await this.useExisting(found, task, meter, emit));
      } else {
        emit('gap', { text: 'No installed capability can do this. Building one.' });
        Object.assign(record, await this.learn(task, meter, emit, app));
      }
    } catch (e) {
      if (e instanceof StoppedError) {
        Object.assign(record, { path: 'stopped', ok: false, error: 'Stopped by you' });
        emit('stopped', { text: 'Stopped by you. Nothing after this point ran.' });
      } else {
        Object.assign(record, { path: 'failed', ok: false, error: e.message });
        emit('error', { text: e.message });
      }
    } finally {
      this.stopRequested = false;
      Object.assign(record, meter.snapshot());
      this.runs.push(record);
      this.current = null;
      this.busy = false;
      await this.saveHistory().catch(() => {});
      this.emit('run', record);
      this.emit('registry', { capabilities: this.registry.summary() });
    }
    return record;
  }

  // Free first (patterns compiled into each capability), then one small model call.
  async route(task, meter, emit, app) {
    const hit = this.registry.match(task, app);
    if (hit) {
      emit('route', { text: `Matched ${hit.cap.name} v${hit.cap.version} by pattern, no model call`, via: 'pattern' });
      return hit;
    }
    const caps = this.registry.all().filter(c => !app || c.manifest?.app === app);
    if (!caps.length) return null;
    const out = await askJSON(meter,
      'Decide whether one of the installed capabilities can do the task. Return {"capability": "<name>" or null, "params": {...}}. Only choose a capability whose description really covers the task, and fill every param.',
      `Task: ${task}\nCapabilities:\n${caps.map(c => `${c.name}(${c.params.map(p => p.name).join(', ')}): ${c.description}`).join('\n')}`);
    const cap = out.capability && this.registry.get(out.capability);
    if (!cap) return null;
    emit('route', { text: `Model routed to ${cap.name} v${cap.version}`, via: 'model' });
    const defaults = Object.fromEntries((cap.params || []).filter(p => p.default !== undefined).map(p => [p.name, p.default]));
    return { cap, params: { ...defaults, ...(out.params || {}) } };
  }

  async useExisting({ cap, params }, task, meter, emit) {
    let allowOnce = false;
    if (cap.status === 'held') {
      const decision = await this.askPermission(cap, params, emit);
      if (decision === 'deny') {
        emit('blocked', { text: `Not allowed, so ${cap.title || cap.name} did not run. Nothing was sent.` });
        return { path: 'held', ok: false, capability: cap.name };
      }
      if (decision === 'always') {
        await this.approve(cap.name);
        emit('step', { kind: 'run', text: `Always allowed: ${cap.title || cap.name} will run without asking from now on` });
      } else {
        allowOnce = true;
        emit('step', { kind: 'run', text: 'Allowed once: it will ask again next time' });
      }
    }
    emit('use', { text: `Running ${cap.name} v${cap.version} as code with ${JSON.stringify(params)}` });
    const res = await run(cap, params, { emit, allowExternal: allowOnce || cap.approved === true });
    if (res.ok) {
      cap.runs = (cap.runs || 0) + 1;
      await this.registry.save(cap);
      emit('done', { text: `Done. Verified on screen: ${res.verified || "final step"}` });
      return { path: 'code', ok: true, capability: `${cap.name} v${cap.version}`, data: res.data };
    }
    if (res.held) {
      emit('blocked', { text: res.reason });
      return { path: 'held', ok: false, capability: cap.name };
    }
    if (res.irreversible) {
      // Something that sends, pays or deletes already ran. Never retry or re-explore on top of it.
      emit('blocked', { text: `${cap.name} ran its irreversible step, but the check after it failed: ${res.reason}. Not retrying; check the phone.` });
      return { path: 'failed', ok: false, capability: `${cap.name} v${cap.version}`, error: res.reason };
    }
    // It broke. Evolve: explore again from the same app, rebuild, retest, install the next version.
    emit('broken', { text: `${cap.name} v${cap.version} failed at step ${res.step}: ${res.reason}. Repairing.` });
    const explored = await explore({ task, meter, emit, pkg: cap.steps[0].pkg });
    const next = await compile({ task, ...explored, meter, emit, previous: cap });
    const installed = await this.testAndInstall(next, meter, emit, cap, `repaired after: ${res.reason}`);
    return { path: 'repaired', ok: installed.status === 'installed', capability: `${installed.name} v${installed.version}`, data: explored.data };
  }

  async learn(task, meter, emit, app) {
    const known = this.registry.all().map(c => ({ name: c.name, app: c.manifest?.app })).filter(k => k.app);
    const explored = await explore({ task, meter, emit, known, pkg: app });
    emit('compile', { text: 'Writing the capability from what just worked' });
    const spec = await compile({ task, ...explored, meter, emit });
    if (explored.held) {
      const cap = await this.install(spec, null, 'learned, stopped before an external action', { passed: 0, total: 0 });
      // The capability is written but held. Ask now, and if allowed, finish the request with it as code.
      const hit = this.registry.match(task);
      if (hit?.cap.name !== cap.name) return { path: 'held', ok: false, capability: `${cap.name} v${cap.version}` };
      const done = await this.useExisting(hit, task, meter, emit);
      return { ...done, path: done.ok ? 'learned' : done.path };
    }
    const cap = await this.testAndInstall(spec, meter, emit, null, `learned from "${task}"`);
    return { path: 'learned', ok: cap.status === 'installed', capability: `${cap.name} v${cap.version}`, data: explored.data };
  }

  async testAndInstall(spec, meter, emit, previous, reason) {
    emit('test', { text: `Testing ${spec.name} with new input ${JSON.stringify(spec.test)}` });
    const defaults = Object.fromEntries((spec.params || []).filter(p => p.default !== undefined).map(p => [p.name, p.default]));
    const res = await run({ ...spec, version: 0 }, { ...defaults, ...spec.test }, { emit });
    const tests = { passed: res.ok ? 1 : 0, total: 1, last: res.ok ? `pass: ${res.verified || 'ok'}` : `fail: ${res.reason}` };
    if (!res.ok) {
      emit('error', { text: `Test failed, not installing: ${res.reason}` });
      throw new Error(`Test failed: ${res.reason}`);
    }
    if (spec.steps.some(st => st.op === 'extract') && !res.data?.length) {
      emit('error', { text: 'Test failed, not installing: the extraction collected no rows' });
      throw new Error('Test failed: the extraction collected no rows');
    }
    emit('test', { text: `Test passed: ${res.verified || 'all steps ran'}` });
    return this.install(spec, previous, reason, tests);
  }

  async install(spec, previous, reason, tests) {
    const verdict = review(spec.manifest);
    const version = (previous?.version || this.registry.get(spec.name)?.version || 0) + 1;
    const cap = {
      ...spec,
      version,
      status: verdict.allowed ? 'installed' : 'held',
      statusReason: verdict.reason,
      approved: false,
      tests,
      runs: 0,
      created: new Date().toISOString(),
      history: [...(previous?.history || []), { version, reason, at: new Date().toISOString() }],
    };
    await this.registry.save(cap);
    this.emit(verdict.allowed ? 'install' : 'blocked', {
      text: verdict.allowed ? `Installed ${cap.name} v${version}` : `${cap.name} v${version} saved but held: ${verdict.reason}`,
    });
    return cap;
  }

  stop() {
    if (this.busy) this.stopRequested = true;
    return this.busy;
  }

  // Before anything that sends, pays or deletes, ask the person, the way Claude Code asks before a risky tool.
  // "once" runs it this time only, "always" approves this one capability for good, "deny" or no answer stops.
  // Authority only grows when a person grants it, and only for the capability they saw.
  async askPermission(cap, params, emit) {
    const values = Object.entries(params || {}).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(', ');
    this.decision = null;
    const title = cap.title || titleFrom(cap.name);
    this.pending = { capability: cap.name, title, app: cap.manifest?.app, params, action: `${title}${values ? ` (${values})` : ''}` };
    emit('ask', { text: `Allow Stitch to ${this.pending.action}? It sends, posts, pays or deletes.`, ask: this.pending });
    const until = Date.now() + 5 * 60 * 1000;
    try {
      while (!this.decision && Date.now() < until) {
        if (this.stopRequested) emit('wait'); // throws StoppedError
        await new Promise(r => setTimeout(r, 150));
      }
      return this.decision || 'deny';
    } finally {
      this.pending = null;
      this.decision = null;
    }
  }

  decide(decision) {
    if (!this.pending || !['once', 'always', 'deny'].includes(decision)) return false;
    this.decision = decision;
    return true;
  }

  async approve(name) {
    const cap = this.registry.get(name);
    if (!cap) throw new Error(`No capability ${name}`);
    cap.status = 'installed';
    cap.approved = true;
    cap.statusReason = 'approved by a person';
    await this.registry.save(cap);
    this.emit('registry', { capabilities: this.registry.summary() });
  }

  // Take back an "always allow": the capability asks again before every run.
  async revoke(name) {
    const cap = this.registry.get(name);
    if (!cap) throw new Error(`No capability ${name}`);
    cap.status = 'held';
    cap.approved = false;
    cap.statusReason = 'it sends, posts, pays or deletes; permission revoked by a person';
    await this.registry.save(cap);
    this.emit('registry', { capabilities: this.registry.summary() });
  }

  // Demo helper: pretend the app shipped an update that renamed a control the capability relies on.
  async simulateUpdate(name) {
    const cap = this.registry.get(name);
    if (!cap) throw new Error(`No capability ${name}`);
    const step = cap.steps.find(s => s.op === 'tap' && s.sel?.resourceId);
    if (!step) throw new Error('Nothing to break');
    step.sel = { ...step.sel, resourceId: step.sel.resourceId + '_v2', labelHas: step.sel.labelHas };
    cap.simulatedBreak = true;
    await this.registry.save(cap);
    this.emit('registry', { capabilities: this.registry.summary() });
    return cap;
  }

  state() {
    return { session: this.session, busy: this.busy, current: this.current, pending: this.pending || null, runs: this.runs, capabilities: this.registry.summary(), granted: GRANTED };
  }
}
