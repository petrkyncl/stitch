// The fast path: run an installed capability as plain code. No model involved.
import * as phone from './adb.mjs';
import { findBySelector, screenHasText } from './ui.mjs';
import { render } from './compiler.mjs';

async function waitFor(sel, obs) {
  let screen = obs;
  for (let i = 0; i < 4; i++) {
    if (!screen) screen = await phone.observe();
    const node = findBySelector(screen.nodes, sel);
    if (node) return { node, screen };
    screen = null;
    await phone.sleep(250);
  }
  return { node: null, screen: null };
}

export async function run(cap, params, { emit, allowExternal = false }) {
  let obs = null;
  for (let i = 0; i < cap.steps.length; i++) {
    const s = cap.steps[i];
    if (s.op === 'launch') {
      emit('step', { kind: 'run', text: `launch ${s.pkg}` });
      await phone.launch(s.pkg);
      await phone.sleep(400);
      obs = null;
      continue;
    }
    if (s.op === 'back') { await phone.key('back'); obs = null; await phone.sleep(350); continue; }
    if (s.op === 'scroll') { await phone.scroll(s.direction); obs = null; await phone.sleep(350); continue; }

    const { node } = await waitFor(s.sel, obs);
    if (!node) return { ok: false, step: i, reason: `element not found: ${s.sel.labelHas || s.sel.resourceId}` };

    if (s.op === 'tap') {
      if (s.external && !allowExternal) return { ok: false, held: true, step: i, reason: `"${s.label}" needs approval` };
      emit('step', { kind: 'run', text: `tap "${s.sel.labelHas || s.label}"` });
      await phone.tap(node);
      obs = null;
      await phone.sleep(450);
    } else if (s.op === 'type') {
      const text = render(s.text, params);
      emit('step', { kind: 'run', text: `type "${text}" into "${s.sel.labelHas}"` });
      await phone.typeInto(node, text);
      obs = null;
    }
  }
  if (!cap.expect) return { ok: true };
  const want = render(cap.expect, params);
  for (let i = 0; i < 4; i++) {
    const screen = await phone.observe();
    if (screenHasText(screen.nodes, want)) return { ok: true, verified: want };
    await phone.sleep(400);
  }
  return { ok: false, step: cap.steps.length, reason: `"${want}" is not on screen after the last step` };
}
