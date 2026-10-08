// The Frankenstein loop: find a capability or notice the gap, build it, test it, install it, reuse it, repair it.
import { Meter, askJSON } from './llm.mjs';
import { explore } from './explorer.mjs';
import { compile } from './compiler.mjs';
import { run } from './runner.mjs';
import { review, GRANTED } from './policy.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const HISTORY = 'runs/history.json';

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

  async handle(task) {
    if (this.busy) throw new Error('Stitch is already working on a task');
    this.busy = true;
    const meter = new Meter();
    const record = { id: `${Date.now()}`, session: this.session, task, at: Date.now(), events: [] };
    this.current = record;
    const emit = (type, data = {}) => {
      if (type !== 'task') record.events.push({ type, kind: data.kind, text: data.text, why: data.why, at: Date.now() });
      this.emit(type, { ...data, runId: record.id, meter: meter.snapshot() });
    };
    emit('task', { task, session: this.session, id: record.id });
    try {
      const found = await this.route(task, meter, emit);
      if (found) {
        Object.assign(record, await this.useExisting(found, task, meter, emit));
      } else {
        emit('gap', { text: 'No installed capability can do this. Building one.' });
        Object.assign(record, await this.learn(task, meter, emit));
      }
    } catch (e) {
      Object.assign(record, { path: 'failed', ok: false, error: e.message });
      emit('error', { text: e.message });
    } finally {
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
  async route(task, meter, emit) {
    const hit = this.registry.match(task);
    if (hit) {
      emit('route', { text: `Matched ${hit.cap.name} v${hit.cap.version} by pattern, no model call`, via: 'pattern' });
      return hit;
    }
    const caps = this.registry.all();
    if (!caps.length) return null;
    const out = await askJSON(meter,
      'Decide whether one of the installed capabilities can do the task. Return {"capability": "<name>" or null, "params": {...}}. Only choose a capability whose description really covers the task, and fill every param.',
      `Task: ${task}\nCapabilities:\n${caps.map(c => `${c.name}(${c.params.map(p => p.name).join(', ')}): ${c.description}`).join('\n')}`);
    const cap = out.capability && this.registry.get(out.capability);
    if (!cap) return null;
    emit('route', { text: `Model routed to ${cap.name} v${cap.version}`, via: 'model' });
    return { cap, params: out.params || {} };
  }

  async useExisting({ cap, params }, task, meter, emit) {
    if (cap.status === 'held') {
      emit('blocked', { text: `${cap.name} is held: ${cap.statusReason}. A person has to approve it.` });
      return { path: 'held', ok: false, capability: cap.name };
    }
    emit('use', { text: `Running ${cap.name} v${cap.version} as code with ${JSON.stringify(params)}` });
    const res = await run(cap, params, { emit, allowExternal: cap.approved === true });
    if (res.ok) {
      cap.runs = (cap.runs || 0) + 1;
      await this.registry.save(cap);
      emit('done', { text: `Done. Verified "${res.verified || 'final step'}" on screen.` });
      return { path: 'code', ok: true, capability: `${cap.name} v${cap.version}` };
    }
    if (res.held) {
      emit('blocked', { text: res.reason });
      return { path: 'held', ok: false, capability: cap.name };
    }
    // It broke. Evolve: explore again from the same app, rebuild, retest, install the next version.
    emit('broken', { text: `${cap.name} v${cap.version} failed at step ${res.step}: ${res.reason}. Repairing.` });
    const explored = await explore({ task, meter, emit, pkg: cap.steps[0].pkg });
    const next = await compile({ task, ...explored, meter, emit, previous: cap });
    const installed = await this.testAndInstall(next, meter, emit, cap, `repaired after: ${res.reason}`);
    return { path: 'repaired', ok: installed.status === 'installed', capability: `${installed.name} v${installed.version}` };
  }

  async learn(task, meter, emit) {
    const explored = await explore({ task, meter, emit });
    emit('compile', { text: 'Writing the capability from what just worked' });
    const spec = await compile({ task, ...explored, meter, emit });
    if (explored.held) {
      const cap = await this.install(spec, null, 'learned, stopped before an external action', { passed: 0, total: 0 });
      return { path: 'held', ok: false, capability: `${cap.name} v${cap.version}` };
    }
    const cap = await this.testAndInstall(spec, meter, emit, null, `learned from "${task}"`);
    return { path: 'learned', ok: cap.status === 'installed', capability: `${cap.name} v${cap.version}` };
  }

  async testAndInstall(spec, meter, emit, previous, reason) {
    emit('test', { text: `Testing ${spec.name} with new input ${JSON.stringify(spec.test)}` });
    const res = await run({ ...spec, version: 0 }, spec.test, { emit });
    const tests = { passed: res.ok ? 1 : 0, total: 1, last: res.ok ? `pass: ${res.verified || 'ok'}` : `fail: ${res.reason}` };
    if (!res.ok) {
      emit('error', { text: `Test failed, not installing: ${res.reason}` });
      throw new Error(`Test failed: ${res.reason}`);
    }
    emit('test', { text: `Test passed: "${res.verified}" is on screen` });
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

  async approve(name) {
    const cap = this.registry.get(name);
    if (!cap) throw new Error(`No capability ${name}`);
    cap.status = 'installed';
    cap.approved = true;
    cap.statusReason = 'approved by a person';
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
    return { session: this.session, busy: this.busy, current: this.current, runs: this.runs, capabilities: this.registry.summary(), granted: GRANTED };
  }
}
