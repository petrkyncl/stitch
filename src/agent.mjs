// The Frankenstein loop: find a capability or notice the gap, build it, test it, install it, reuse it, repair it.
import { Meter, askJSON, askTool, LIMITS } from './llm.mjs';
import { explore } from './explorer.mjs';
import { compile, matchPatterns } from './compiler.mjs';
import { run } from './runner.mjs';
import { review, GRANTED } from './policy.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { titleFrom } from './registry.mjs';
import { globalAction, installedApps } from './adb.mjs';

// Phone buttons the agent has from the start. Requests for them run directly, with no model and nothing to learn.
const BUILTINS = [
  { re: /^(go|press|tap)?\s*(to\s+)?(the\s+)?home(\s+screen|\s+button)?\.?$/i, action: 'home' },
  { re: /^(go|press|tap)?\s*back(\s+button)?\.?$/i, action: 'back' },
  { re: /^(open|show|press)?\s*(the\s+)?recent(s| apps)?\.?$/i, action: 'recents' },
  { re: /^(open|show|pull down)\s+(the\s+)?notifications?\.?$/i, action: 'notifications' },
];

const SPLIT = {
  name: 'split',
  description: 'The tasks in the request, in order.',
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'One task in the words of the request. If it uses what the task before it returns, write the literal placeholder {{previous}} exactly where that goes, e.g. "Send Ann a WhatsApp message saying {{previous}}"' },
            uses_previous: { type: 'boolean', description: 'true when this task needs what the task before it returns (an answer, a found place)' },
            returns_result: { type: 'boolean', description: 'true when a later task uses what this task gets back' },
          },
          required: ['task', 'uses_previous', 'returns_result'],
        },
      },
    },
    required: ['tasks'],
  },
};

// Several tasks in one request: it succeeds when every task did; it learned when any task learned.
function combine(results, total) {
  if (results.length === 1 && total === 1) return results[0];
  const failed = results.find(r => !r.ok);
  const path = failed ? failed.path : results.some(r => r.path === 'learned') ? 'learned' : results.some(r => r.path === 'repaired') ? 'repaired' : 'code';
  return {
    path,
    ok: !failed && results.length === total,
    capability: results.map(r => r.capability).filter(Boolean).join(' + ') || undefined,
    data: [...results].reverse().find(r => r.data?.length)?.data,
    reply: [...results].reverse().find(r => r.reply)?.reply,
    error: failed?.error,
  };
}
import { latestFrame, keepWarm } from './stream.mjs';

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
    this.chat = 1; // a thread of requests; everything before chats existed is chat 1
    this.runs = [];
    this.busy = false;
  }

  // Runs survive an engine restart, so the studio keeps its chat and the learning-vs-reuse numbers.
  async loadHistory() {
    try {
      const saved = JSON.parse(await readFile(HISTORY, 'utf8'));
      this.runs = saved.runs || [];
      this.session = saved.session || 1;
      this.chat = saved.chat || 1;
    } catch { /* first start */ }
    return this;
  }

  async saveHistory() {
    await mkdir('runs', { recursive: true });
    await writeFile(HISTORY, JSON.stringify({ session: this.session, chat: this.chat, runs: this.runs.slice(-200) }, null, 1));
  }

  // A new chat starts a new session too: fresh memory, and only what is on disk carries over.
  async newSession() {
    this.chat += 1;
    this.session += 1;
    await this.registry.load(); // nothing carries over except what is on disk
    await this.saveHistory();
    this.emit('session', { session: this.session, capabilities: this.registry.all().length });
  }

  // `app` (optional) is the package the person chose; it narrows routing and skips guessing the app.
  // `capability` + `params` run one installed capability directly (from the MCP server), skipping routing.
  async handle(task, { app, capability, params } = {}) {
    if (this.busy) throw new Error('Stitch is already working on a task');
    this.busy = true;
    const meter = new Meter();
    const record = { id: `${Date.now()}`, chat: this.chat, session: this.session, task, app, at: Date.now(), events: [] };
    this.current = record;
    let frames = 0;
    let pendingShot = null;
    // The snapshot belongs to an event already shown; once it is on disk, the event gets it and the studio is told.
    const shoot = () => {
      if (pendingShot === null) return;
      const { n, idx } = pendingShot;
      pendingShot = null;
      const jpg = latestFrame();
      if (!jpg) return;
      const frame = `/api/frame/${record.id}/${n}.jpg`;
      mkdir(`runs/frames/${record.id}`, { recursive: true })
        .then(() => writeFile(`runs/frames/${record.id}/${n}.jpg`, jpg))
        .then(() => { if (record.events[idx]) record.events[idx].frame = frame; this.emit('frame', { runId: record.id, idx, frame }); })
        .catch(() => {});
    };
    this.stopRequested = false;
    const emit = (type, data = {}) => {
      // Every step reports progress through here before it acts, so a stop lands before the next action.
      if (this.stopRequested && !['error', 'run', 'stopped', 'blocked'].includes(type)) throw new StoppedError();
      // Keep what the phone showed at this step, straight from the live video, so the chat can replay the run.
      // A step is announced before it acts, so its snapshot is taken when the next step is announced (the screen
      // then shows what this step did: the opened app, the typed text). The last one is taken when the run ends.
      if (FRAME_KINDS.has(data.kind || type)) {
        shoot();
        pendingShot = { n: frames++, idx: record.events.length };
        keepWarm();
      }
      if (type !== 'task') record.events.push({ type, kind: data.kind, text: data.text, why: data.why, at: Date.now() });
      this.emit(type, { ...data, runId: record.id, meter: meter.snapshot() });
    };
    keepWarm(); // real snapshots for every step, even with the studio closed
    emit('task', { task, session: this.session, id: record.id });
    try {
      // "Do this and then that" becomes separate tasks, each one routed, run or learned on its own.
      const direct = capability && this.registry.get(capability);
      if (capability && !direct) throw new Error(`No installed capability ${capability}`);
      const tasks = direct ? [task] : await this.split(task, meter, emit);
      const results = [];
      for (let [i, one] of tasks.entries()) {
        // Capabilities compose: what the previous task got back fills {{previous}} in this one.
        if (one.includes('{{previous}}')) {
          const prev = results.at(-1);
          const value = prev?.reply || (prev?.data?.length ? Object.values(prev.data[0]).join(', ') : '');
          if (!value) throw new Error(`Task ${i + 1} needs the result of task ${i}, which returned nothing`);
          one = one.replaceAll('{{previous}}', value.replace(/\s*\n\s*/g, ' ').slice(0, 500));
        }
        if (tasks.length > 1) emit('step', { kind: 'plan', text: `Task ${i + 1} of ${tasks.length}: ${one}` });
        const res = direct
          ? await this.useExisting({ cap: direct, params: { ...Object.fromEntries((direct.params || []).filter(p => p.default !== undefined).map(p => [p.name, p.default])), ...params } }, one, meter, emit)
          : await this.one(one, meter, emit, tasks.length === 1 ? app : undefined);
        results.push(res);
        if (!res.ok) break;
      }
      Object.assign(record, combine(results, tasks.length));
    } catch (e) {
      if (e instanceof StoppedError) {
        Object.assign(record, { path: 'stopped', ok: false, error: 'Stopped by you' });
        emit('stopped', { text: 'Stopped by you. Nothing after this point ran.' });
      } else {
        Object.assign(record, { path: 'failed', ok: false, error: e.message });
        emit('error', { text: e.message });
      }
    } finally {
      await new Promise(r => setTimeout(r, 700)); // the video is a moment behind the phone
      shoot();
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

  async one(task, meter, emit, app) {
    const builtin = BUILTINS.find(b => b.re.test(task.trim()));
    if (builtin) {
      // Phone buttons are what Stitch starts with; nothing to learn.
      emit('step', { kind: 'run', text: `press ${builtin.action}, a phone button Stitch already has` });
      await globalAction(builtin.action);
      emit('done', { text: `Done: pressed ${builtin.action}` });
      return { path: 'code', ok: true };
    }
    const found = await this.route(task, meter, emit, app);
    if (found) return this.useExisting(found, task, meter, emit);
    emit('gap', { text: 'No installed capability can do this. Building one.' });
    return this.learn(task, meter, emit, app);
  }

  // One small model call, only when the request has a connective like "and then".
  async split(task, meter, emit) {
    if (!/\b(and|then|after that|afterwards|a pak|potom)\b/i.test(task)) return [task];
    // A request one capability already covers is not split (free, and keeps reuse at zero model calls).
    await this.registry.load();
    if (this.registry.match(task)) return [task];
    const out = await askTool(meter,
      'Split a phone request into the separate tasks it asks for, in order. Keep the words of the request and make each task ' +
      'complete on its own (repeat the app or person if needed). The text of a message is never split. A single task stays alone.',
      `Request, quoted: "${task}"`, SPLIT);
    // A task whose result a later one uses asks for that result back; a task that uses it gets the placeholder.
    const tasks = (Array.isArray(out.tasks) ? out.tasks : []).slice(0, 5).map(t => {
      let text = String(typeof t === 'string' ? t : t?.task || '').trim();
      if (t?.returns_result && !/give me the (result|answer)/i.test(text)) text += ' and give me the result';
      if (t?.uses_previous && !text.includes('{{previous}}')) text += ': {{previous}}';
      return text;
    }).filter(Boolean);
    if (tasks.length < 2) return [task];
    emit('step', { kind: 'plan', text: `Split into ${tasks.length} tasks: ${tasks.map(t => `"${t}"`).join(', ')}` });
    return tasks;
  }

  // Free first (patterns compiled into each capability), then one small model call.
  async route(task, meter, emit, app) {
    // The registry may be shared with other devices: read it fresh, and only consider apps this device has.
    await this.registry.load();
    const installed = new Set((await installedApps().catch(() => [])).map(a => a.package));
    const hit = this.registry.match(task, app, installed);
    if (hit) {
      emit('route', { text: `Matched ${hit.cap.name} v${hit.cap.version} by pattern, no model call`, via: 'pattern' });
      return hit;
    }
    const caps = this.registry.all().filter(c => (!app || c.manifest?.app === app) && (!installed.size || !c.manifest?.app || installed.has(c.manifest.app)));
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

  async useExisting({ cap, params }, task, meter, emit, { repair = true, from = 0, pkg = '' } = {}) {
    // It runs right up to the step that sends, pays or deletes, then asks, with the result of every step before
    // it on screen. An "always" from an earlier run means it does not ask.
    const confirm = async step => {
      const decision = await this.askPermission(cap, params, emit, step);
      if (decision === 'always') {
        await this.approve(cap.name);
        emit('step', { kind: 'run', text: `Always allowed: ${cap.title || titleFrom(cap.name)} will run without asking from now on` });
      } else if (decision === 'once') {
        emit('step', { kind: 'run', text: 'Allowed once: it will ask again next time' });
      }
      return decision !== 'deny';
    };
    emit('use', { text: from ? `Installed ${cap.name} v${cap.version}; finishing on the screen it prepared` : `Running ${cap.name} v${cap.version} as code with ${JSON.stringify(params)}` });
    let res = await run(cap, params, { emit, allowExternal: cap.approved === true, confirm, from, pkg });
    // The prepared screen changed under it (nothing irreversible happened yet): run the whole program instead.
    if (from && !res.ok && !res.held && !res.irreversible) res = await run(cap, params, { emit, allowExternal: cap.approved === true, confirm });
    if (res.ok) {
      cap.runs = (cap.runs || 0) + 1;
      await this.registry.save(cap);
      emit('done', { text: `Done. Verified on screen: ${res.verified || "final step"}` });
      if (res.reply) emit('answer', { text: res.reply });
      return { path: 'code', ok: true, capability: `${cap.name} v${cap.version}`, data: res.data, reply: res.reply };
    }
    if (res.held) {
      emit('blocked', { text: `Not allowed, so it stopped before ${res.reason.split(' was')[0]}. Nothing was sent; what it prepared is still on the phone.` });
      return { path: 'held', ok: false, capability: `${cap.name} v${cap.version}` };
    }
    if (res.irreversible) {
      // Something that sends, pays or deletes already ran. Never retry or re-explore on top of it.
      emit('blocked', { text: `${cap.name} ran its irreversible step, but the check after it failed: ${res.reason}. Not retrying; check the phone.` });
      return { path: 'failed', ok: false, capability: `${cap.name} v${cap.version}`, error: res.reason };
    }
    if (!repair) {
      emit('error', { text: `${cap.name} v${cap.version} failed at step ${res.step}: ${res.reason}` });
      return { path: 'failed', ok: false, capability: `${cap.name} v${cap.version}`, error: res.reason };
    }
    // It broke. Evolve: explore again from the same app, rebuild, retest, install the next version.
    emit('broken', { text: `${cap.name} v${cap.version} failed at step ${res.step}: ${res.reason}. Repairing.` });
    const explored = await explore({ task, meter, emit, pkg: cap.steps[0].pkg });
    const next = await compile({ task, ...explored, meter, emit, previous: cap });
    if (explored.held) {
      // The repaired program ends in a send: it cannot be tested for real, so save it held and finish the request
      // with it, asking at the send.
      const values = { ...params, ...(matchPatterns(next.patterns, task) || {}) };
      const fixed = await this.dryRunAndInstall(next, values, meter, emit, cap, `repaired after: ${res.reason}`);
      const from = Math.max(fixed.steps.findLastIndex(s => s.external), 0);
      const done = await this.useExisting({ cap: fixed, params: values }, task, meter, emit, { repair: false, from, pkg: explored.heldIn });
      return { ...done, path: done.ok ? 'repaired' : done.path };
    }
    const installed = await this.testAndInstall(next, meter, emit, cap, `repaired after: ${res.reason}`);
    return { path: 'repaired', ok: installed.status === 'installed', capability: `${installed.name} v${installed.version}`, data: explored.data };
  }

  async learn(task, meter, emit, app) {
    const known = this.registry.all().map(c => ({ name: c.name, app: c.manifest?.app })).filter(k => k.app);
    const explored = await explore({ task, meter, emit, known, pkg: app });
    emit('compile', { text: 'Writing the capability from what just worked' });
    const spec = await compile({ task, ...explored, meter, emit });
    if (explored.held) {
      // Test it with a dry run up to the send, install it held, then finish the request on the prepared screen.
      const defaults = Object.fromEntries((spec.params || []).filter(p => p.default !== undefined).map(p => [p.name, p.default]));
      const values = { ...defaults, ...(matchPatterns(spec.patterns, task) || {}) };
      const cap = await this.dryRunAndInstall(spec, values, meter, emit, null, `learned from "${task}"`);
      const hit = { cap, params: this.registry.match(task)?.params || values };
      const from = Math.max(cap.steps.findLastIndex(s => s.external), 0);
      const done = await this.useExisting(hit, task, meter, emit, { repair: false, from, pkg: explored.heldIn });
      return { ...done, path: done.ok ? 'learned' : done.path };
    }
    const cap = await this.testAndInstall(spec, meter, emit, null, `learned from "${task}"`);
    return { path: 'learned', ok: cap.status === 'installed', capability: `${cap.name} v${cap.version}`, data: explored.data };
  }

  // A capability that ends in a send, payment or delete is tested with a dry run: every step up to that one runs for
  // real with the request's own values (never someone else's chat), and that step is left unpressed. It installs only
  // if the dry run reached it with everything before it working.
  async dryRunAndInstall(spec, params, meter, emit, previous, reason) {
    const at = spec.steps.findLastIndex(s => s.external);
    const label = spec.steps[at]?.label || 'the last step';
    emit('test', { text: `Testing ${spec.name} with ${JSON.stringify(params)} up to "${label}", which the test does not press` });
    const res = await run({ ...spec, version: 0 }, params, { emit, confirm: async () => false });
    const ok = !!res.held && res.step === at;
    const tests = { passed: ok ? 1 : 0, total: 1, dry: true, last: ok ? `pass: every step up to "${label}" worked; that step waits for a person` : `fail: ${res.reason}` };
    if (!ok) {
      emit('error', { text: `Test failed, not installing: ${res.reason}` });
      throw new Error(`Test failed: ${res.reason}`);
    }
    emit('test', { text: `Test passed: everything up to "${label}" is ready on the phone` });
    return this.install(spec, previous, reason, tests);
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
    // Same name already learned for a different app (Samsung Clock vs Google Clock on another device): keep both.
    const other = !previous && this.registry.get(spec.name);
    if (other && other.manifest?.app && spec.manifest?.app && other.manifest.app !== spec.manifest.app) {
      spec = { ...spec, name: `${spec.name}_${spec.manifest.app.split('.').pop().replace(/\W/g, '')}` };
    }
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
  async askPermission(cap, params, emit, step) {
    const values = Object.entries(params || {}).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(', ');
    this.decision = null;
    const title = cap.title || titleFrom(cap.name);
    this.pending = { capability: cap.name, title, app: cap.manifest?.app, params, step: step?.label, action: `${title}${values ? ` (${values})` : ''}` };
    emit('ask', { text: `Everything is ready. Tap "${step?.label || 'the last step'}" to ${this.pending.action}? It cannot be taken back.`, ask: this.pending });
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
    return { limits: LIMITS, session: this.session, chat: this.chat, busy: this.busy, current: this.current, pending: this.pending || null, runs: this.runs, capabilities: this.registry.summary(), granted: GRANTED };
  }
}
