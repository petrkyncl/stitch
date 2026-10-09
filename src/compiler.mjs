// Turns one explored trace into a reusable capability: parameters, trigger patterns,
// templated steps, a success check and a test with different inputs.
import { appendFile } from 'node:fs/promises';
import { askTool, exploreModel } from './llm.mjs';
import { manifestFor } from './policy.mjs';

const FILTERS = {
  pad2: v => String(v).padStart(2, '0'),
  upper: v => String(v).toUpperCase(),
  lower: v => String(v).toLowerCase(),
  trim: v => String(v).trim(),
};

// Apps print times with a leading zero; people and models often don't. Compare and search times padded.
const fold = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

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
  return new RegExp(src, 'is'); // s: a value can span lines (a poem passed on to a message)
}

const escapeLiteral = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');

// "... and give me the result" asks for the answer back; it is not part of what gets sent. Request values may be quoted.
const REPLY_TAIL = /\s+and\s+(give|tell|show|send)\s+me\s+(the\s+)?(result|answer|reply|response)s?\.?$/i;
export function cleanParams(params, reply) {
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v).replace(reply ? REPLY_TAIL : /$^/, '').trim()
    .replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, '').trim()]));
}

// A prompt typed as "Write a poem about Prague." is the same text as "write a poem about Prague".
const sameText = (a, b) => { const f = x => fold(padTimes(x)).replace(/[\s.!?]+$/, '').trim(); return f(a) === f(b); };

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
Text typed from the request (a message, a prompt, a search) is always a param, never a constant: for "prompt Claude to
give me a joke" the param is prompt = "give me a joke", so the same capability also sends "write me a poem".
If the agent chose a value the request did not give (e.g. the wording of a greeting), make it a param with a "default"
equal to what was used, so later requests can override it but do not have to.
Templates use {{param}} with optional filters: {{hour|pad2}} pads to two digits, also |upper |lower |trim.
Every kept "type", "find" and "extract" step needs a template in "typed" (for find the text searched for, for extract
the number of rows, e.g. "{{count}}" when the request names a number, else the literal number). Drop steps that were detours or that tapped a value which depends
on the input only incidentally (for example tapping the "07" button in a picker when the hour is also typed).
When the element itself is chosen by the input (the list item "07:14" to delete, the contact "David" to open), keep the
step and give its label as a template in "targets", e.g. {"step":2,"label":"{{hour|pad2}}:{{minute}}"}.
When the request covers all or every item (delete all alarms, mark every chat read) and the trace did it for one item,
set repeat and repeat_step: the program repeats from that step while such an item is left.
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
      repeat: { type: 'boolean', description: 'true when the request is about all or every item ("delete all alarms") but the trace handled one: the program then repeats until no such item is left' },
      repeat_step: { type: 'integer', description: 'With repeat: the trace step that picks the item to act on (e.g. the long press on an alarm)' },
      reply: { type: 'boolean', description: 'true when the request wants back what the app answers after the last step, e.g. "and give me the result", "what does it say"' },
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

export async function compile({ task, trace, expect, final, meter, emit, previous }) {
  // A find at the very end, or one that looks for the success text, only checked the result during exploration.
  // The final check already does that, so it is not part of the program (it would scroll the list on every run).
  trace = trace.filter((s, i) => !(s.op === 'find' && (i === trace.length - 1 || (expect && fold(padTimes(s.text)) === fold(padTimes(expect))))));
  const steps = trace.map((s, i) => ({ i, ...s }));
  let feedback = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const spec = shape(await askTool(meter, SYSTEM,
      `Original request, quoted: "${task}"\nSuccess text seen: ${expect || (final ? '(none yet: the last step saves and was not pressed; give expect as the short text that will show after it, e.g. {{hour|pad2}}:{{minute}})' : '(none, the last step was held before an external action)')}\n` +
      (previous ? `This replaces ${previous.name} v${previous.version}; keep its name and params.\n` : '') +
      `Trace:\n${JSON.stringify(steps, null, 1)}${feedback}`, TOOL, { model: exploreModel })); // part of learning: once per capability
    appendFile('runs/decisions.jsonl', JSON.stringify({ at: Date.now(), compile: attempt + 1, name: spec.name, params: spec.params, patterns: spec.patterns, typed: spec.typed, targets: spec.targets, expect: spec.expect, reply: spec.reply }) + '\n').catch(() => {}); // for reports
    const problems = validate(spec, task, trace, expect);
    if (!problems.length) {
      // "All of them": the step that picks an item matches any item of that kind (its id, not this item's label), and
      // the program repeats from it while one is left.
      const repeatAt = spec.repeat && Number.isInteger(spec.repeat_step) && trace[spec.repeat_step]?.sel?.resourceId ? spec.repeat_step : -1;
      if (repeatAt >= 0) delete spec.targets[String(repeatAt)];
      const program = trace
        .map((s, i) => (i === repeatAt ? { ...s, item: true, sel: { resourceId: s.sel.resourceId, labelHas: '', cls: s.sel.cls } } : s))
        .map((s, i) => (['type', 'find', 'extract'].includes(s.op) ? { ...s, text: spec.typed[String(i)] } : s))
        .map((s, i) => (spec.targets[String(i)] && s.sel ? { ...s, sel: { ...s.sel, labelHas: spec.targets[String(i)], templated: true } } : s))
        .filter((st, i) => i === 0 || KEEP.has(st.op) || st.item || st.final || st.external || !spec.drop.has(i));
      const manifest = { ...manifestFor(program), app: trace[0]?.pkg };
      const { drop, drop_steps, typed, targets, repeat_step, ...clean } = spec;
      clean.repeat = repeatAt >= 0;
      if (!expect) {
        // Nothing was shown as proof (the run stopped before an irreversible step), so check the effect instead.
        // If it typed something, the proof is that text showing outside the field, sent (a message, a comment).
        // Otherwise, the element it acted on is gone (a deleted alarm).
        // A save that was mapped, not pressed: the model's template of what will show after it is the proof.
        const proof = final && clean.expect && matchPatterns(spec.patterns, task) ? clean.expect : '';
        clean.expect = proof;
        const typed = [...program].reverse().find(st => st.op === 'type' && st.text);
        const chosen = program.find(st => st.sel?.templated);
        if (clean.repeat || proof) { /* checked by the loop: no item left, or by the expected text */ }
        else if (typed) clean.sent = typed.text;
        else if (chosen) clean.gone = chosen.sel.labelHas;
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
  const matched = matchPatterns(spec.patterns, task) && cleanParams(matchPatterns(spec.patterns, task), spec.reply);
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
      if (i === 0 || (spec.drop.has(i) && !KEEP.has(s.op))) return; // kept steps are checked even when marked for dropping
      const target = spec.targets?.[String(i)] && (autofix(spec.targets[String(i)], got, s.label || '', true) || spec.targets[String(i)]);
      if (target) spec.targets[String(i)] = target;
      if (target) {
        // Spaces do not count: "@{{contact}}" with "petr kyncl" has to match the handle "@petrkyncl".
        const squash = x => fold(x).replace(/\s+/g, '');
        const want = squash(padTimes(render(target, got)));
        if (!want || !squash(s.label).includes(want)) problems.push(`target for step ${i} renders "${render(target, got)}" but the tapped element was "${s.label}"`);
        return;
      }
      if ((s.op === 'tap' || s.op === 'long_press') && values.some(v => new RegExp(`(^|\\D)0*${String(v).replace(/^0+(?=\d)/, '')}(\\D|$)`).test(s.sel?.labelHas || s.label || ''))) {
        problems.push(`step ${i} taps "${s.label}", which depends on the input; drop it, or if the input chooses this element give it a label template in "targets"`);
      }
      if (s.op !== 'type' && s.op !== 'find' && s.op !== 'extract') return;
      let t = spec.typed?.[String(i)];
      // No template given: if the text is a value from the request, point it at that param; else keep it literal.
      if (t === undefined) {
        const p = Object.entries(got).find(([, v]) => fold(v) && fold(v) === fold(s.text));
        t = p ? `{{${p[0]}}}` : s.text;
        spec.typed[String(i)] = t;
      }
      if (t !== undefined) { const fixed = autofix(t, got, s.text); if (fixed) { t = fixed; spec.typed[String(i)] = fixed; } }
      // Words typed straight from the request must come from a param, or the capability only ever sends that one text.
      if (s.op === 'type' && t !== undefined && !String(t).includes('{{') && /[a-z]{3}/i.test(s.text || '') && fold(task).includes(fold(s.text))) {
        problems.push(`step ${i} types "${s.text}" from the request as a constant; make it a param and type {{param}}`);
      }
      if (t === undefined) problems.push(`missing typed template for step ${i}`);
      else if (!sameText(render(t, got), s.text)) {
        const rendered = render(t, got);
        const tooMuch = fold(rendered).startsWith(fold(s.text)) ? `; the pattern captured too much: end the group where "${s.text}" ends (lazy group) and allow the rest, e.g. "${rendered.slice(s.text.length).trim()}", as an optional tail` : '';
        problems.push(`step ${i} renders "${rendered}" but the trace typed "${s.text}"${tooMuch}`);
      }
    });
    // A param no step uses is a request the program ignores, e.g. a message it never types.
    // Only steps count: a held capability throws its success text away, so a param used only there does nothing.
    const used = JSON.stringify([spec.typed, spec.targets, expect ? spec.expect : '']);
    for (const p of params) if (!used.includes(`{{${p}`)) problems.push(`param "${p}" is not used by any step; type it, target it, or remove it`);
    if (expect && spec.expect) {
      const fixed = autofix(spec.expect, got, expect, true);
      if (fixed) spec.expect = fixed;
      if (!render(spec.expect, got)) problems.push('expect renders empty');
    }
  }
  if (!spec.test || params.some(p => !(p in spec.test))) problems.push('test must give a value for every param');
  return problems;
}
