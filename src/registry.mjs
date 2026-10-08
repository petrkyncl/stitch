// Installed capabilities live on disk, one folder each, every version kept.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { matchPatterns } from './compiler.mjs';

const ROOT = path.resolve('registry');

export class Registry {
  constructor() { this.caps = new Map(); }

  async load() {
    this.caps.clear();
    await mkdir(ROOT, { recursive: true });
    for (const dir of await readdir(ROOT)) {
      try {
        const cap = JSON.parse(await readFile(path.join(ROOT, dir, 'capability.json'), 'utf8'));
        this.caps.set(cap.name, cap);
      } catch { /* not a capability folder */ }
    }
    return this;
  }

  async save(cap) {
    const dir = path.join(ROOT, cap.name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'capability.json'), JSON.stringify(cap, null, 2));
    await writeFile(path.join(dir, `v${cap.version}.json`), JSON.stringify(cap, null, 2));
    this.caps.set(cap.name, cap);
  }

  get(name) { return this.caps.get(name); }
  all() { return [...this.caps.values()]; }

  // Free routing: regex patterns written at compile time, no model call.
  match(task) {
    for (const cap of this.caps.values()) {
      const params = matchPatterns(cap.patterns, task);
      if (params) return { cap, params };
    }
    return null;
  }

  summary() {
    return this.all().map(c => ({
      name: c.name,
      version: c.version,
      description: c.description,
      params: c.params.map(p => p.name),
      effect: c.manifest.effect,
      permissions: c.manifest.permissions,
      status: c.status,
      reason: c.statusReason,
      tests: c.tests,
      runs: c.runs || 0,
      steps: c.steps.length,
      history: c.history,
    }));
  }
}
