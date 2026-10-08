// The fast path: run an installed capability as plain code. No model involved.
import * as phone from './adb.mjs';
import { findBySelector, screenHasText } from './ui.mjs';
import { render } from './compiler.mjs';

// Poll the tree until the element shows up. Reading it costs ~20 ms, so waiting is cheap; apps that just
// launched get longer.
async function waitFor(sel, pkg, timeoutMs) {
  const until = Date.now() + timeoutMs;
  do {
    const screen = await phone.observe(pkg);
    const node = findBySelector(screen.nodes, sel);
    if (node) return node;
    await phone.sleep(150);
  } while (Date.now() < until);
  return null;
}

export async function run(cap, params, { emit, allowExternal = false }) {
  let pkg = '';
  let justLaunched = false;
  for (let i = 0; i < cap.steps.length; i++) {
    const s = cap.steps[i];
    const say = text => emit('step', { kind: 'run', text });

    if (s.op === 'launch') {
      say(`open ${s.pkg}`);
      await phone.launch(s.pkg);
      pkg = s.pkg;
      justLaunched = true;
      continue;
    }
    if (s.op === 'global' || s.op === 'back') {
      const name = s.name || 'back';
      say(`press ${name}`);
      await phone.globalAction(name);
      await phone.sleep(350);
      continue;
    }
    if (s.op === 'enter') {
      // Enter goes to whatever field has focus, which is the one the previous step typed into.
      say('press enter');
      await phone.pressEnter();
      await phone.sleep(400);
      continue;
    }
    if (s.op === 'scroll' && !s.sel) {
      say(`scroll ${s.direction}`);
      await phone.scroll(s.direction);
      await phone.sleep(350);
      continue;
    }

    const node = await waitFor(s.sel, pkg, justLaunched ? 8000 : 4000);
    justLaunched = false;
    if (!node) return { ok: false, step: i, reason: `element not found: ${s.sel.labelHas || s.sel.resourceId}` };

    if (s.op === 'tap') {
      if (s.external && !allowExternal) return { ok: false, held: true, step: i, reason: `"${s.label}" needs approval` };
      say(`tap "${s.sel.labelHas || s.label}"`);
      await phone.tap(node);
      await phone.sleep(400);
    } else if (s.op === 'long_press') {
      say(`long press "${s.sel.labelHas || s.label}"`);
      await phone.nodeAction(node, 'long_click');
      await phone.sleep(500);
    } else if (s.op === 'type') {
      const text = render(s.text, params);
      say(`type "${text}" into "${s.sel.labelHas || s.label || "the field"}"`);
      await phone.typeInto(node, text);
    } else if (s.op === 'enter') {
      say(`enter on "${s.sel.labelHas}"`);
      await phone.pressEnter();
      await phone.sleep(400);
    } else if (s.op === 'scroll') {
      say(`scroll ${s.direction}`);
      await phone.nodeAction(node, s.direction === 'up' ? 'scroll_backward' : 'scroll_forward').catch(() => phone.scroll(s.direction));
      await phone.sleep(350);
    }
  }
  if (!cap.expect) return { ok: true };
  const want = render(cap.expect, params);
  for (let i = 0; i < 6; i++) {
    const screen = await phone.observe(pkg);
    if (screenHasText(screen.nodes, want)) return { ok: true, verified: want };
    await phone.sleep(300);
  }
  return { ok: false, step: cap.steps.length, reason: `"${want}" is not on screen after the last step` };
}
