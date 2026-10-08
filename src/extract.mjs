// Data extraction from lists on screen. The model looks at a few sample rows once and writes field rules;
// collecting, de-duplicating and scrolling through a lazy-loading list is plain code after that.
import * as phone from './adb.mjs';
import { askTool } from './llm.mjs';

const inside = (a, b) => a.bounds[0] >= b.bounds[0] && a.bounds[1] >= b.bounds[1] && a.bounds[2] <= b.bounds[2] && a.bounds[3] <= b.bounds[3];
const area = n => (n.bounds[2] - n.bounds[0]) * (n.bounds[3] - n.bounds[1]);

function rowsIn(list, nodes) {
  const width = list.bounds[2] - list.bounds[0];
  const candidates = nodes.filter(n => n !== list && n.clickable && inside(n, list)
    && (n.bounds[2] - n.bounds[0]) >= 0.8 * width && (n.bounds[3] - n.bounds[1]) >= 80 && area(n) < 0.8 * area(list));
  // Keep the outermost rows only (a row may contain clickable children of the same width).
  return candidates.filter(r => !candidates.some(o => o !== r && inside(r, o)));
}

function textsOf(row, nodes) {
  const texts = [];
  for (const n of nodes) {
    if (n === row || !inside(n, row)) continue;
    const t = phone.label(n).trim();
    if (t && !texts.includes(t)) texts.push(t);
  }
  return texts;
}

// The list is the scrollable container holding the most data rows (wide clickable items with at least three texts);
// on a tie the smaller container wins, so a full-screen scroll view loses to the results list inside it.
export function rowsOnScreen(nodes) {
  let best = { list: null, rows: [] };
  for (const list of nodes.filter(n => n.scrollable)) {
    const rows = rowsIn(list, nodes).map(r => textsOf(r, nodes)).filter(t => t.length >= 3);
    if (rows.length > best.rows.length || (rows.length && rows.length === best.rows.length && area(list) < area(best.list))) best = { list, rows };
  }
  if (best.rows.length) return best;
  // Some lists are not marked scrollable in the accessibility tree; treat the whole screen as the list then.
  const screen = nodes.reduce((a, n) => (area(n) > area(a) ? n : a), nodes[0]);
  if (!screen) return best;
  const virtual = { ...screen, bounds: screen.bounds, scrollable: true };
  const rows = rowsIn(virtual, nodes).map(r => textsOf(r, nodes)).filter(t => t.length >= 2);
  return rows.length >= 2 ? { list: virtual, rows } : best;
}

const RULES = {
  name: 'define_extractor',
  description: 'Rules that turn one row (a list of its texts, top to bottom) into a record',
  parameters: {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Column name, snake_case' },
            regex: { type: 'string', description: 'JavaScript regex tested on each text of the row; capture group 1 is the value if present' },
            index: { type: 'integer', description: 'Instead of regex: position of the text in the row after ignored texts are removed (0 = first)' },
          },
          required: ['name'],
        },
      },
      ignore: { type: 'array', items: { type: 'string' }, description: 'Regexes for texts that are not data, e.g. ads labels or button captions' },
      key: { type: 'string', description: 'Field that identifies a row, used to drop duplicates while scrolling' },
    },
    required: ['fields', 'key'],
  },
};

const re = s => { try { return new RegExp(s, 'i'); } catch { return null; } };

// Texts that repeat in most sample rows ("Sponsored", "Directions") are captions, not data.
export function commonTexts(rows) {
  if (rows.length < 2) return [];
  const count = new Map();
  for (const r of rows) for (const t of new Set(r)) count.set(t, (count.get(t) || 0) + 1);
  return [...count].filter(([, n]) => n >= Math.max(2, Math.ceil(rows.length * 0.6))).map(([t]) => t);
}

export function cleanRow(rules, texts) {
  const drop = new Set(rules.drop || []);
  const ignore = (rules.ignore || []).map(re).filter(Boolean);
  return texts.filter(t => !drop.has(t) && !ignore.some(r => r.test(t)));
}

const tidy = v => String(v).replace(/^[\s,;:·•|-]+|[\s,;:·•|-]+$/g, '');

export function applyRules(rules, texts) {
  // Ignore rules only decide what counts as "the n-th text"; regexes look at every non-caption text.
  const kept = cleanRow(rules, texts);
  const drop = new Set(rules.drop || []);
  const all = texts.filter(t => !drop.has(t));
  const rec = {};
  for (const f of rules.fields) {
    if (f.regex) {
      // Models often anchor a regex to the whole text; if that finds nothing, try it unanchored.
      const r = re(f.regex);
      const loose = re(String(f.regex).replace(/^\^/, '').replace(/\$$/, ''));
      const hit = (r && all.map(t => t.match(r)).find(Boolean)) || (loose && all.map(t => t.match(loose)).find(Boolean));
      rec[f.name] = hit ? tidy(hit[1] ?? hit[0]) : '';
    } else {
      rec[f.name] = tidy(kept[f.index ?? 0] ?? '');
    }
  }
  return rec;
}

export async function defineExtractor({ meter, task, fields, rows }) {
  const drop = commonTexts(rows);
  const view = rows.map(t => t.filter(x => !drop.includes(x)));
  const sample = view.slice(0, 4).map((t, i) => `Row ${i + 1}: ${JSON.stringify(t)}`).join('\n');
  let feedback = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const rules = await askTool(meter,
      'You write extraction rules for rows of a list in an Android app. Each row is given as the list of its texts. '
      + 'Use regex for values with a recognizable shape (ratings, prices, distances, times) and index for plain names or titles. '
      + 'Rules must work for every row of this list, not only the samples: never put sample values (like a specific rating) into a regex. '
      + 'index counts positions in the rows exactly as shown. Ignore texts that are labels of buttons or ads.',
      `Request, quoted: "${task}"\nFields wanted: ${fields?.length ? fields.join(', ') : 'whatever a person would want in a spreadsheet for this request'}\n\n${sample}${feedback}`,
      RULES);
    rules.fields = (rules.fields || []).filter(f => f.name);
    rules.drop = drop;
    if (!rules.key || !rules.fields.some(f => f.name === rules.key)) rules.key = rules.fields[0]?.name;
    // Local check: every field must be filled in at least one sample row, the key in most of them.
    const recs = rows.slice(0, 4).map(t => applyRules(rules, t));
    if (process.env.DEBUG_EXTRACT) console.error('extract rules', JSON.stringify(rules), JSON.stringify(recs));
    // Two fields with the same value in a row usually means an index pointing at the wrong text.
    const clash = recs.some(r => { const v = Object.values(r).filter(Boolean); return new Set(v).size < v.length; });
    if (clash) { feedback = `\n\nYour rules ${JSON.stringify(rules)} gave two fields the same value in one row. Fix them.`; continue; }
    const empty = rules.fields.filter(f => !recs.some(r => r[f.name]));
    const keyed = recs.filter(r => r[rules.key]).length;
    if (rules.fields.length && !empty.length && keyed >= Math.ceil(recs.length / 2)) return rules;
    feedback = `\n\nYour rules ${JSON.stringify(rules)} left these fields empty on every sample: ${empty.map(f => f.name).join(', ') || '(none)'}; key filled in ${keyed}/${recs.length} rows. `
      + 'A regex is tested with String.match against each single text of the row, so it must match inside a text like "4,2 stars, 1172 ratings". '
      + 'Write a new regex for each empty field.';
  }
  throw new Error('Could not write extraction rules that fill the requested fields');
}

// Collect records, scrolling the list until `limit` is reached or nothing new appears twice in a row.
export async function collect({ rules, limit = 20, pkg, emit = () => {} }) {
  const seen = new Map();
  let stale = 0;
  for (let page = 0; page < 40 && seen.size < limit && stale < 2; page++) {
    const screen = await phone.observe(pkg);
    const { list, rows } = rowsOnScreen(screen.nodes);
    let added = 0;
    for (const texts of rows) {
      const rec = applyRules(rules, texts);
      const key = String(rec[rules.key] || '').toLowerCase();
      // Ads, image tiles and buttons in the list fill the name and nothing else; a real row fills more.
      const filled = Object.values(rec).filter(Boolean).length;
      if (!key || (rules.fields.length > 1 && filled < 2)) continue;
      // A row cut off at the list edge can put e.g. a distance into the name; the key must not repeat another field.
      if (Object.entries(rec).some(([k, v]) => k !== rules.key && v && v === rec[rules.key])) continue;
      const prev = seen.get(key);
      // A row cut off at the edge may be missing fields; keep the fuller version.
      if (!prev) { seen.set(key, rec); added++; } else if (Object.values(rec).filter(Boolean).length > Object.values(prev).filter(Boolean).length) seen.set(key, rec);
      if (seen.size >= limit) break;
    }
    stale = added ? 0 : stale + 1;
    emit(`collected ${Math.min(seen.size, limit)} of ${limit}`);
    if (seen.size >= limit || !list) break;
    const [x1, y1, x2, y2] = list.bounds;
    const x = Math.round((x1 + x2) / 2);
    await phone.swipeAt(x, y2 - 150, x, Math.max(y1 + 150, y2 - 150 - (y2 - y1) * 0.7), 350);
    await phone.sleep(700); // lazy lists load the next page after the scroll settles
  }
  return [...seen.values()].slice(0, limit);
}
