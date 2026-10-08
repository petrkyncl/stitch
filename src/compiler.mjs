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

// Apps print times with a leading zero; people and models often don't. Compare and search times padded.
export const padTimes = s => String(s).replace(/(^|[^\d])(\d):(\d{2})(?!\d)/g, '$10$2:$3');

export function render(template, params) {
  return String(template ?? '').replace(/\{\{\s*(\w+)((?:\|\w+)*)\s*\}\}/g, (_, name, filters) => {
    let v = params[name] ?? '';
    for (const f of filters.split('|').filter(Boolean)) v = FILTERS[f] ? FILTERS[f](v) : v;
    return v;
  });
}

// Models write patterns three ways: JavaScript regex, Python regex, or a template like "Find {{query}} in Maps".
// Accept all three and turn them into a JavaScript RegExp.
const TEMPLATE_SLOT = /\{\{\s*(\w+)\s*(?:\|[\w|]+)?\s*\}\}|\{([A-Za-z_]\w*)\}/g;

export function toRegExp(p) {
  let src = String(p).trim();
  const lit = src.match(/^\/(.*)\/[a-z]*$/s);
  if (lit) src = lit[1];
  src = src.replace(/^\(\?i\)/, '').replace(/\(\?P</g, '(?<').replace(/\(\?P=(\w+)\)/g, '\\k<$1>');
  if (TEMPLATE_SLOT.test(src) && !/\(\?</.test(src)) {
    TEMPLATE_SLOT.lastIndex = 0;
    let out = '';
    let last = 0;
    for (const m of src.matchAll(TEMPLATE_SLOT)) {
      out += escapeLiteral(src.slice(last, m.index)) + `(?<${m[1] || m[2]}>.+?)`;
      last = m.index + m[0].length;
    }
    out += escapeLiteral(src.slice(last));
    src = `^\\s*${out}\\s*[.!?]?\\s*$`;
  }
  TEMPLATE_SLOT.lastIndex = 0;
  return new RegExp(src, 'i');
}

const escapeLiteral = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');

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
If the agent chose a value the request did not give (e.g. the wording of a greeting), make it a param with a "default"
equal to what was used, so later requests can override it but do not have to.
Templates use {{param}} with optional filters: {{hour|pad2}} pads to two digits, also |upper |lower |trim.
Every kept "type", "find" and "extract" step needs a template in "typed" (for find the text searched for, for extract
the number of rows, e.g. "{{count}}" when the request names a number, else the literal number). Drop steps that were detours or that tapped a value which depends
on the input only incidentally (for example tapping the "07" button in a picker when the hour is also typed).
When the element itself is chosen by the input (the list item "07:14" to delete, the contact "David" to open), keep the
step and give its label as a template in "targets", e.g. {"step":2,"label":"{{hour|pad2}}:{{minute}}"}.
Give 2-4 regex patterns (JavaScript, named groups for every param, case-insensitive) that match natural requests like the original.`;

const TOOL = {
  name: 'define_capability',
  description: 'Define the reusable capability learned from the trace',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'app.verb_object in lowercase, e.g. clock.set_alarm' },
      title: { type: 'string', description: 'What it does for a person, 2 to 4 words, e.g. "Set an alarm"' },
      description: { type: 'string', description: 'One plain sentence for a non-programmer, no package names' },
      params: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, example: { type: 'string' }, default: { type: 'string', description: 'Value used when the request does not say it' } }, required: ['name', 'description', 'example'] } },
      patterns: { type: 'array', items: { type: 'string' } },
      drop_steps: { type: 'array', items: { type: 'integer' }, description: 'Indices of trace steps to leave out' },
      typed: { type: 'array', items: { type: 'object', properties: { step: { type: 'integer' }, template: { type: 'string' } }, required: ['step', 'template'] } },
      targets: { type: 'array', description: 'Steps whose element is chosen by the input: label template of that element', items: { type: 'object', properties: { step: { type: 'integer' }, label: { type: 'string' } }, required: ['step', 'label'] } },
      expect: { type: 'string', description: 'Template of a short text visible after success, e.g. {{hour|pad2}}:{{minute}}' },
      test: { type: 'array', description: 'Test input, every param with a value different from the original task', items: { type: 'object', properties: { param: { type: 'string' }, value: { type: 'string' } }, required: ['param', 'value'] } },
    },
    required: ['name', 'description', 'params', 'patterns', 'drop_steps', 'typed', 'expect', 'test'],
  },
};

// Steps that carry the input or the result are never dropped, whatever the model says.
const KEEP = new Set(['launch', 'type', 'enter', 'find', 'extract']);

// Tool arguments arrive as arrays; the rest of the code wants maps.
function shape(raw) {
  return {
    ...raw,
    params: Array.isArray(raw.params) ? raw.params : [],
    patterns: Array.isArray(raw.patterns) ? raw.patterns : [],
    drop: new Set(Array.isArray(raw.drop_steps) ? raw.drop_steps.map(Number) : []),
    typed: Object.fromEntries((Array.isArray(raw.typed) ? raw.typed : []).map(t => [String(t.step), t.template])),
    targets: Object.fromEntries((Array.isArray(raw.targets) ? raw.targets : []).map(t => [String(t.step), t.label])),
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
        .map((s, i) => (['type', 'find', 'extract'].includes(s.op) ? { ...s, text: spec.typed[String(i)] } : s))
        .map((s, i) => (spec.targets[String(i)] && s.sel ? { ...s, sel: { ...s.sel, labelHas: spec.targets[String(i)], templated: true } } : s))
        .filter((st, i) => i === 0 || KEEP.has(st.op) || !spec.drop.has(i));
      const manifest = { ...manifestFor(program), app: trace[0]?.pkg };
      const { drop, drop_steps, typed, targets, ...clean } = spec;
      if (!expect) {
        // Nothing was shown as proof (the run stopped before an irreversible step). Check instead that the element
        // the capability acted on is gone afterwards, e.g. the deleted alarm.
        clean.expect = '';
        const chosen = program.find(st => st.sel?.templated);
        if (chosen) clean.gone = chosen.sel.labelHas;
      }
      return { ...clean, name: previous?.name || spec.name, steps: program, manifest };
    }
    emit('step', { kind: 'compile', text: `Compiler check failed, retrying: ${problems[0]}`, meter: meter.snapshot() });
    feedback = `\n\nYour previous answer failed these checks, fix them:\n- ${problems.join('\n- ')}\nPrevious answer: ${JSON.stringify({ ...spec, drop: [...spec.drop] })}`;
  }
  throw new Error('Could not compile a capability that reproduces the trace');
}

// Small models forget zero padding ("7" vs "07"). Try every combination of adding or removing |pad2 on the
// slots and keep the one that reproduces what actually happened.
function autofix(template, params, wanted, contains = false) {
  const slots = [...String(template).matchAll(/\{\{\s*(\w+)((?:\|\w+)*)\s*\}\}/g)];
  const ok = t => (contains ? String(wanted).toLowerCase().includes(render(t, params).toLowerCase()) && render(t, params) : render(t, params) === wanted);
  if (ok(template)) return template;
  for (let mask = 1; mask < 1 << slots.length && slots.length <= 6; mask++) {
    let i = 0;
    const t = String(template).replace(/\{\{\s*(\w+)((?:\|\w+)*)\s*\}\}/g, (m, name, filters) => {
      const flip = mask & (1 << i++);
      if (!flip) return m;
      return filters.includes('pad2') ? `{{${name}${filters.replace('|pad2', '')}}}` : `{{${name}|pad2${filters}}}`;
    });
    if (ok(t)) return t;
  }
  return null;
}

// Local checks, no model: the capability must reproduce exactly what was typed for the original task.
export function validate(spec, task, trace, expect) {
  const problems = [];
  if (!spec.name || !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(spec.name)) problems.push('name must look like app.verb_object');
  const params = (spec.params || []).map(p => p.name);
  const matched = matchPatterns(spec.patterns, task);
  // Params the request did not mention take their default.
  const got = matched && { ...Object.fromEntries((spec.params || []).filter(p => p.default !== undefined).map(p => [p.name, p.default])), ...matched };
  if (!got) problems.push(`no pattern matches the original request "${task}". Your patterns: ${JSON.stringify(spec.patterns)}. They are JavaScript RegExp sources tested case-insensitively with String.match, named groups like (?<hour>\\d{1,2})`);
  for (const p of spec.patterns || []) {
    try { toRegExp(p); } catch { problems.push(`invalid regex ${p}`); }
  }
  if (got) {
    for (const p of params) if (!(p in got)) problems.push(`pattern does not capture param "${p}" and it has no default`);
    const values = Object.values(got).filter(v => String(v).length > 0);
    // Label templates only make sense on steps that touch an element.
    for (const k of Object.keys(spec.targets || {})) if (!['tap', 'long_press'].includes(trace[Number(k)]?.op)) delete spec.targets[k];
    trace.forEach((s, i) => {
      if (i === 0 || spec.drop.has(i)) return;
      const target = spec.targets?.[String(i)] && (autofix(spec.targets[String(i)], got, s.label || '', true) || spec.targets[String(i)]);
      if (target) spec.targets[String(i)] = target;
      if (target) {
        const want = padTimes(render(target, got)).toLowerCase();
        if (!want || !String(s.label || '').toLowerCase().includes(want)) problems.push(`target for step ${i} renders "${render(target, got)}" but the tapped element was "${s.label}"`);
        return;
      }
      if ((s.op === 'tap' || s.op === 'long_press') && values.some(v => new RegExp(`(^|\\D)0*${String(v).replace(/^0+(?=\d)/, '')}(\\D|$)`).test(s.sel?.labelHas || s.label || ''))) {
        problems.push(`step ${i} taps "${s.label}", which depends on the input; drop it, or if the input chooses this element give it a label template in "targets"`);
      }
      if (s.op !== 'type' && s.op !== 'find' && s.op !== 'extract') return;
      let t = spec.typed?.[String(i)];
      if (t !== undefined) { const fixed = autofix(t, got, s.text); if (fixed) { t = fixed; spec.typed[String(i)] = fixed; } }
      if (t === undefined) problems.push(`missing typed template for step ${i}`);
      else if (padTimes(render(t, got)) !== padTimes(s.text)) problems.push(`step ${i} renders "${render(t, got)}" but the trace typed "${s.text}"`);
    });
    if (expect && spec.expect) {
      const fixed = autofix(spec.expect, got, expect, true);
      if (fixed) spec.expect = fixed;
      if (!render(spec.expect, got)) problems.push('expect renders empty');
    }
  }
  if (!spec.test || params.some(p => !(p in spec.test))) problems.push('test must give a value for every param');
  return problems;
}
