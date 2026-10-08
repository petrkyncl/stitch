// Turns one explored trace into a reusable capability: parameters, trigger patterns,
// templated steps, a success check and a test with different inputs.
import { askTool } from './llm.mjs';
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

// Models often write regexes in Python or /literal/ style; convert them to plain JavaScript source.
export function toRegExp(p) {
  let src = String(p).trim();
  const lit = src.match(/^\/(.*)\/[a-z]*$/s);
  if (lit) src = lit[1];
  src = src.replace(/^\(\?i\)/, '').replace(/\(\?P</g, '(?<').replace(/\(\?P=(\w+)\)/g, '\\k<$1>');
  return new RegExp(src, 'i');
}

export function matchPatterns(patterns, task) {
  for (const p of patterns || []) {
    let re;
    try { re = toRegExp(p); } catch { continue; }
    const m = task.match(re);
    if (m) return { ...(m.groups || {}) };
  }
  return null;
}

const SYSTEM = `You turn a recorded Android UI trace into a reusable, parameterized capability.
Values the user chose (times, names, search words) become params; everything else stays constant.
Templates use {{param}} with optional filters: {{hour|pad2}} pads to two digits, also |upper |lower |trim.
Every kept "type" step needs a template in "typed". Drop steps that were detours or that tapped a value which depends
on the input (for example tapping the "07" button in a picker when the hour is also typed), so the steps work for any input.
Give 2-4 regex patterns (JavaScript, named groups for every param, case-insensitive) that match natural requests like the original.`;

const TOOL = {
  name: 'define_capability',
  description: 'Define the reusable capability learned from the trace',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'app.verb_object in lowercase, e.g. clock.set_alarm' },
      description: { type: 'string' },
      params: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, example: { type: 'string' } }, required: ['name', 'description', 'example'] } },
      patterns: { type: 'array', items: { type: 'string' } },
      drop_steps: { type: 'array', items: { type: 'integer' }, description: 'Indices of trace steps to leave out' },
      typed: { type: 'array', items: { type: 'object', properties: { step: { type: 'integer' }, template: { type: 'string' } }, required: ['step', 'template'] } },
      expect: { type: 'string', description: 'Template of a short text visible after success, e.g. {{hour|pad2}}:{{minute}}' },
      test: { type: 'array', description: 'Test input, every param with a value different from the original task', items: { type: 'object', properties: { param: { type: 'string' }, value: { type: 'string' } }, required: ['param', 'value'] } },
    },
    required: ['name', 'description', 'params', 'patterns', 'drop_steps', 'typed', 'expect', 'test'],
  },
};

// Tool arguments arrive as arrays; the rest of the code wants maps.
function shape(raw) {
  return {
    ...raw,
    params: Array.isArray(raw.params) ? raw.params : [],
    patterns: Array.isArray(raw.patterns) ? raw.patterns : [],
    drop: new Set(Array.isArray(raw.drop_steps) ? raw.drop_steps.map(Number) : []),
    typed: Object.fromEntries((Array.isArray(raw.typed) ? raw.typed : []).map(t => [String(t.step), t.template])),
    test: Object.fromEntries((Array.isArray(raw.test) ? raw.test : []).map(t => [t.param, String(t.value)])),
  };
}

export async function compile({ task, trace, expect, meter, emit, previous }) {
  const steps = trace.map((s, i) => ({ i, ...s }));
  let feedback = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const spec = shape(await askTool(meter, SYSTEM,
      `Original request, quoted: "${task}"\nSuccess text seen: ${expect || '(none, the last step was held before an external action)'}\n` +
      (previous ? `This replaces ${previous.name} v${previous.version}; keep its name and params.\n` : '') +
      `Trace:\n${JSON.stringify(steps, null, 1)}${feedback}`, TOOL));
    const problems = validate(spec, task, trace, expect);
    if (!problems.length) {
      const program = trace
        .map((s, i) => (s.op === 'type' ? { ...s, text: spec.typed[String(i)] } : s))
        .filter((_, i) => i === 0 || !spec.drop.has(i));
      const manifest = { ...manifestFor(program), app: trace[0]?.pkg };
      const { drop, drop_steps, typed, ...clean } = spec;
      return { ...clean, name: previous?.name || spec.name, steps: program, manifest };
    }
    emit('step', { kind: 'compile', text: `Compiler check failed, retrying: ${problems[0]}`, meter: meter.snapshot() });
    feedback = `\n\nYour previous answer failed these checks, fix them:\n- ${problems.join('\n- ')}\nPrevious answer: ${JSON.stringify({ ...spec, drop: [...spec.drop] })}`;
  }
  throw new Error('Could not compile a capability that reproduces the trace');
}

// Local checks, no model: the capability must reproduce exactly what was typed for the original task.
function validate(spec, task, trace, expect) {
  const problems = [];
  if (!spec.name || !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(spec.name)) problems.push('name must look like app.verb_object');
  const params = (spec.params || []).map(p => p.name);
  const got = matchPatterns(spec.patterns, task);
  if (!got) problems.push(`no pattern matches the original request "${task}". Your patterns: ${JSON.stringify(spec.patterns)}. They are JavaScript RegExp sources tested case-insensitively with String.match, named groups like (?<hour>\\d{1,2})`);
  for (const p of spec.patterns || []) {
    try { toRegExp(p); } catch { problems.push(`invalid regex ${p}`); }
  }
  if (got) {
    for (const p of params) if (!(p in got)) problems.push(`pattern does not capture param "${p}"`);
    const values = Object.values(got).filter(v => String(v).length > 0);
    trace.forEach((s, i) => {
      if (i === 0 || spec.drop.has(i)) return;
      if (s.op === 'tap' && values.some(v => new RegExp(`(^|\\D)0*${String(v).replace(/^0+(?=\d)/, '')}(\\D|$)`).test(s.sel?.labelHas || s.label || ''))) {
        problems.push(`step ${i} taps "${s.label}", which depends on the input; drop it`);
      }
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
