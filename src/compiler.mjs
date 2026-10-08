// Turns one explored trace into a reusable capability: parameters, trigger patterns,
// templated steps, a success check and a test with different inputs.
import { askJSON } from './llm.mjs';
import { manifestFor } from './policy.mjs';

const FILTERS = {
  pad2: v => String(v).padStart(2, '0'),
  upper: v => String(v).toUpperCase(),
  lower: v => String(v).toLowerCase(),
  trim: v => String(v).trim(),
};

export function render(template, params) {
  return String(template ?? '').replace(/\{\{\s*(\w+)((?:\|\w+)*)\s*\}\}/g, (_, name, filters) => {
    let v = params[name] ?? '';
    for (const f of filters.split('|').filter(Boolean)) v = FILTERS[f] ? FILTERS[f](v) : v;
    return v;
  });
}

export function matchPatterns(patterns, task) {
  for (const p of patterns || []) {
    let re;
    try { re = new RegExp(p, 'i'); } catch { continue; }
    const m = task.match(re);
    if (m) return { ...(m.groups || {}) };
  }
  return null;
}

const SYSTEM = `You turn a recorded Android UI trace into a reusable, parameterized capability. Return JSON:
{
 "name": "app.verb_object" (lowercase, e.g. "clock.set_alarm"),
 "description": "one sentence",
 "params": [{"name":"...","description":"...","example":"..."}],
 "patterns": ["JavaScript regex with named groups for every param, matching natural requests like the task, case-insensitive"],
 "typed": {"<step index>": "template for the text typed in that step"},
 "expect": "template of text that is visible after success",
 "test": {"<param>": "<value different from the task's value>"}
}
Templates use {{param}} and optional filters: {{hour|pad2}} pads to two digits, also |upper |lower |trim.
Every "type" step needs an entry in "typed". Values the user chose become params; constant text stays literal.
Give 2-4 patterns that cover common phrasings. Patterns must not be greedy across the whole sentence.`;

export async function compile({ task, trace, expect, meter, emit, previous }) {
  const steps = trace.map((s, i) => ({ i, ...s }));
  let feedback = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const spec = await askJSON(meter, SYSTEM,
      `Task: ${task}\nSuccess text seen: ${expect || '(none, the last step was held before an external action)'}\n` +
      (previous ? `This replaces ${previous.name} v${previous.version}; keep its name and params.\n` : '') +
      `Trace:\n${JSON.stringify(steps, null, 1)}${feedback}`);
    const problems = validate(spec, task, trace, expect);
    if (!problems.length) {
      const program = trace.map((s, i) => (s.op === 'type' ? { ...s, text: spec.typed[String(i)] } : s));
      const manifest = { ...manifestFor(program), app: trace[0]?.pkg };
      return { ...spec, name: previous?.name || spec.name, steps: program, manifest };
    }
    emit('step', { kind: 'compile', text: `Compiler check failed, retrying: ${problems[0]}`, meter: meter.snapshot() });
    feedback = `\n\nYour previous answer failed these checks, fix them:\n- ${problems.join('\n- ')}\nPrevious answer: ${JSON.stringify(spec)}`;
  }
  throw new Error('Could not compile a capability that reproduces the trace');
}

// Local checks, no model: the capability must reproduce exactly what was typed for the original task.
function validate(spec, task, trace, expect) {
  const problems = [];
  if (!spec.name || !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(spec.name)) problems.push('name must look like app.verb_object');
  const params = (spec.params || []).map(p => p.name);
  const got = matchPatterns(spec.patterns, task);
  if (!got) problems.push(`no pattern matches the original task "${task}"`);
  for (const p of spec.patterns || []) {
    try { new RegExp(p, 'i'); } catch { problems.push(`invalid regex ${p}`); }
  }
  if (got) {
    for (const p of params) if (!(p in got)) problems.push(`pattern does not capture param "${p}"`);
    trace.forEach((s, i) => {
      if (s.op !== 'type') return;
      const t = spec.typed?.[String(i)];
      if (t === undefined) problems.push(`missing typed template for step ${i}`);
      else if (render(t, got) !== s.text) problems.push(`step ${i} renders "${render(t, got)}" but the trace typed "${s.text}"`);
    });
    if (expect && spec.expect && !render(spec.expect, got)) problems.push('expect renders empty');
  }
  if (!spec.test || params.some(p => !(p in spec.test))) problems.push('test must give a value for every param');
  return problems;
}
