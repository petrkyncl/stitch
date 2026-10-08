// Turning raw UI nodes into something a model can read, and selectors that survive between runs.
import { label } from './adb.mjs';

// Only nodes a person could read or touch.
export function visible(nodes) {
  return nodes.filter(n => n.clickable || n.editable || n.scrollable || label(n) || n.resourceId);
}

export function compact(nodes) {
  return visible(nodes)
    .filter(n => n.clickable || n.editable || label(n))
    .slice(0, 120)
    .map(n => {
      const role = n.editable ? 'input' : n.clickable ? 'button' : 'text';
      const rid = n.resourceId ? ` #${n.resourceId.split('/').pop()}` : '';
      const state = n.checked ? ' [checked]' : n.focused ? ' [focused]' : '';
      return `${n.id} ${role} "${label(n).slice(0, 80)}"${rid}${state}`;
    })
    .join('\n');
}

// A selector describes a node by what stays stable: its resource id and a fragment of its label.
export function selectorFor(node, hint = '') {
  return {
    resourceId: node.resourceId || '',
    labelHas: hint || stableLabel(node),
    cls: node.cls,
  };
}

// Strip values that change between runs, e.g. "06, Hour" keeps "Hour".
function stableLabel(node) {
  const l = label(node);
  if (!l) return '';
  const words = l.split(/,\s*/).filter(w => w && !/^\d[\d:.\s]*$/.test(w));
  return (words[words.length - 1] || l).slice(0, 60);
}

export function findBySelector(nodes, sel) {
  const lc = s => String(s || '').toLowerCase();
  const matches = nodes.filter(n => {
    if (sel.resourceId && n.resourceId !== sel.resourceId) return false;
    if (sel.labelHas && !lc(label(n)).includes(lc(sel.labelHas))) return false;
    if (!sel.resourceId && !sel.labelHas) return false;
    return true;
  });
  // Prefer something we can act on.
  return matches.find(n => n.editable) || matches.find(n => n.clickable) || matches[0] || null;
}

export function screenHasText(nodes, text) {
  const t = String(text).toLowerCase();
  return nodes.some(n => label(n).toLowerCase().includes(t));
}

// The model sometimes describes the proof instead of quoting it. Accept the whole text, a quoted part,
// or a time/number token from it, as long as that exact piece is on screen. Returns the piece that matched.
export function provenText(nodes, expect) {
  const e = String(expect || '').trim();
  if (!e) return null;
  const pieces = [e, ...[...e.matchAll(/"([^"]{2,40})"/g)].map(m => m[1]), ...(e.match(/\b\d{1,2}:\d{2}\b/g) || [])];
  return pieces.find(p => screenHasText(nodes, p)) || null;
}
