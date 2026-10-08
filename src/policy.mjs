// Authority is fixed when the agent starts. Capabilities can grow, this list cannot.
export const GRANTED = Object.freeze({
  permissions: Object.freeze(['read_screen', 'tap', 'type']),
  effects: Object.freeze(['local']),
});

// Agreeing to terms and granting permissions are a person's decision too, not only sending, paying and deleting.
const EXTERNAL = /\b(send|post|publish|pay|buy|order|purchase|checkout|call|delete|remove|share|submit|transfer|agree|accept|allow|grant|consent|odeslat|zaplatit|smazat|souhlas\w*|povolit)\b/i;

export const isExternalLabel = label => EXTERNAL.test(String(label || ''));

// An unlabeled button (Gemini's send arrow) has no text to judge. The model says what each step is for; when that
// starts with such a verb ("Send the typed prompt"), the step is treated the same. Only the start counts, so a goal
// mentioned later ("Open New chat to send ...") does not.
export const externalIntent = why => {
  const head = String(why || '').trim().split(/\s+/).slice(0, 2).join(' ');
  return (head.match(EXTERNAL) || [])[0] || null;
};

export function manifestFor(steps) {
  const permissions = new Set(['read_screen']);
  for (const s of steps) {
    if (s.op === 'tap' || s.op === 'back' || s.op === 'scroll') permissions.add('tap');
    if (s.op === 'type') permissions.add('type');
  }
  const effect = steps.some(s => s.external) ? 'external' : 'local';
  return { permissions: [...permissions], effect };
}

// What the registry is allowed to install without a person.
export function review(manifest) {
  const extraPerms = manifest.permissions.filter(p => !GRANTED.permissions.includes(p));
  const extraEffect = !GRANTED.effects.includes(manifest.effect);
  if (!extraPerms.length && !extraEffect) return { allowed: true, reason: 'within granted authority' };
  const parts = [];
  if (extraEffect) parts.push(`effect "${manifest.effect}" was not granted`);
  if (extraPerms.length) parts.push(`permissions ${extraPerms.join(', ')} were not granted`);
  return { allowed: false, reason: parts.join('; ') };
}
