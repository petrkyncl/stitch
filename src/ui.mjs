// Turning raw UI nodes into something a model can read, and selectors that survive between runs.
import { label } from './adb.mjs';

// Case and diacritics do not matter when matching what a person typed against the screen: "kyncl" finds "Kynčl".
export const fold = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// Only nodes a person could read or touch.
export function visible(nodes) {
  return nodes.filter(n => n.clickable || n.editable || n.scrollable || label(n) || n.resourceId);
}

const inside = (a, b) => a.bounds[0] >= b.bounds[0] && a.bounds[1] >= b.bounds[1] && a.bounds[2] <= b.bounds[2] && a.bounds[3] <= b.bounds[3];

export function compact(nodes) {
  const shown = visible(nodes).filter(n => n.clickable || n.editable || label(n));
  // A list row often repeats every child's text in its own label; keep the row, drop the echoes.
  const speaking = shown.filter(n => (n.clickable || n.editable) && label(n).length > 0);
  return shown
    .filter(n => n.clickable || n.editable || !speaking.some(p => p !== n && inside(n, p) && label(p).includes(label(n))))
    .slice(0, 120)
    .map(n => {
      const role = n.editable ? 'input' : n.clickable ? 'button' : 'text';
      const rid = n.resourceId ? ` #${n.resourceId.split('/').pop()}` : '';
      const state = n.checked ? ' [checked]' : n.focused ? ' [focused]' : '';
      return `${n.id} ${role} "${label(n).replace(/, Double tap to [^,]*\.?/g, '').slice(0, 70)}"${rid}${state}`;
    })
    .join('\n');
}

// A selector describes a node by what stays stable: its resource id and a fragment of its label.
// `nodes` (the screen) lets an input be told apart from siblings that share its resource id.
export function selectorFor(node, hint = '', nodes = []) {
  // An input's label is usually whatever is typed in it, so its resource id is the stable part. When several inputs
  // share that id (Samsung's hour and minute pickers), the non-numeric part of the label ("Hour") tells them apart.
  if (node.editable && node.resourceId) {
    const twins = nodes.filter(n => n !== node && n.editable && n.resourceId === node.resourceId).length;
    return { resourceId: node.resourceId, labelHas: hint || (twins ? stableLabel(node) : ''), cls: node.cls };
  }
  const sel = { resourceId: node.resourceId || '', labelHas: hint || stableLabel(node), cls: node.cls };
  // Nothing names it (an icon button without id or label): remember where it was, and match the nearest one there.
  if (!sel.resourceId && !sel.labelHas) sel.at = [node.cx, node.cy];
  return sel;
}

// Strip values that change between runs, e.g. "06, Hour" keeps "Hour".
function stableLabel(node) {
  const l = label(node);
  if (!l) return '';
  const words = l.split(/,\s*/).filter(w => w && !/^\d[\d:.\s]*$/.test(w));
  return (words[words.length - 1] || l).slice(0, 60);
}

export function findBySelector(nodes, sel) {
  if (!sel.resourceId && !sel.labelHas && sel.at) {
    const [x, y] = sel.at;
    const near = nodes
      .filter(n => n.cls === sel.cls && n.clickable && Math.hypot(n.cx - x, n.cy - y) < 90)
      .sort((a, b) => Math.hypot(a.cx - x, a.cy - y) - Math.hypot(b.cx - x, b.cy - y));
    return near[0] || null;
  }
  const lc = fold;
  const matches = nodes.filter(n => {
    if (sel.resourceId && n.resourceId !== sel.resourceId) return false;
    // Spaces do not count, as in the compiler: "@{{contact}}" with "petr kyncl" finds "@petrkyncl".
    if (sel.labelHas && !lc(label(n)).replace(/\s+/g, '').includes(lc(sel.labelHas).replace(/\s+/g, ''))) return false;
    if (!sel.resourceId && !sel.labelHas) return false;
    return true;
  });
  // Prefer something we can act on.
  return matches.find(n => n.editable) || matches.find(n => n.clickable) || matches[0] || null;
}

// Times count with or without the leading zero: "07:45" is found on a clock that shows "7:45 AM".
export function screenHasText(nodes, text) {
  const t = fold(text);
  const short = t.replace(/(^|\D)0(\d:\d\d)/g, '$1$2');
  return nodes.some(n => { const l = fold(label(n)); return l.includes(t) || (short !== t && l.includes(short)); });
}

// The model sometimes describes the proof instead of quoting it. Accept the whole text, a quoted part,
// or a time/number token from it, as long as that exact piece is on screen. Returns the piece that matched.
export function provenText(nodes, expect) {
  const e = String(expect || '').trim();
  if (!e) return null;
  const pieces = [e, ...[...e.matchAll(/"([^"]{2,40})"/g)].map(m => m[1]), ...(e.match(/\b\d{1,2}:\d{2}\b/g) || [])];
  return pieces.find(p => screenHasText(nodes, p)) || null;
}
