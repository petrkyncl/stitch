// The fast path: run an installed capability as plain code. No model involved.
import * as phone from './adb.mjs';
import { findBySelector, screenHasText } from './ui.mjs';
import { render, padTimes } from './compiler.mjs';
import { collect } from './extract.mjs';

// Poll the tree until the element shows up. Reading it costs ~20 ms, so waiting is cheap; apps that just
// launched get longer.
let seen = []; // the screen the last waitFor read, for the overlay

async function waitFor(sel, pkg, timeoutMs) {
  const until = Date.now() + timeoutMs;
  do {
    const screen = await phone.observe(pkg);
    const node = findBySelector(screen.nodes, sel);
    seen = screen.nodes;
    if (node) return node;
    await phone.sleep(150);
  } while (Date.now() < until);
  return null;
}

// `confirm(step)` is asked right before a step that sends, pays or deletes, with everything before it already
// done on screen, so the person sees exactly what would go out. Without it such a step holds the run.
export async function run(cap, params, { emit, allowExternal = false, confirm = null }) {
  let pkg = '';
  let justLaunched = false;
  let irreversible = false; // set once a step that sends, pays or deletes has run
  for (let i = 0; i < cap.steps.length; i++) {
    const s = cap.steps[i];
    const say = text => emit('step', { kind: 'run', text });

    if (s.op === 'launch') {
      say(`open ${s.pkg}`);
      await phone.launch(s.pkg);
      pkg = s.pkg;
      justLaunched = true;
      await phone.settle(pkg, 3000);
      if (s.home?.length) {
        const back = await phone.returnToTabs(pkg, s.home);
        if (back.length) say(`back to the ${back.join(', ')} tab it was learned on`);
      }
      continue;
    }
    if (s.op === 'global' || s.op === 'back') {
      const name = s.name || 'back';
      say(`press ${name}`);
      await phone.globalAction(name);
      await phone.sleep(350);
      continue;
    }
    if (s.op === 'extract') {
      const limit = Number(render(s.text, params)) || 20;
      say(`extract up to ${limit} rows`);
      const data = await collect({ rules: s.rules, limit, pkg, emit: text => say(text) });
      return data.length ? { ok: true, verified: `${data.length} rows collected`, data } : { ok: false, step: i, reason: 'the list gave no rows' };
    }
    if (s.op === 'find') {
      const text = padTimes(render(s.text, params));
      say(`find "${text}"`);
      if (!await phone.findText(text, pkg)) return { ok: false, step: i, reason: `"${text}" is not in the list` };
      continue;
    }
    if (s.op === 'enter') {
      // Enter goes to whatever field has focus, which is the one the previous step typed into.
      say('press enter');
      await phone.pressEnter();
      await phone.settle(pkg);
      continue;
    }
    if (s.op === 'scroll' && !s.sel) {
      say(`scroll ${s.direction}`);
      await phone.scroll(s.direction);
      await phone.sleep(350);
      continue;
    }

    const sel = s.sel?.templated ? { ...s.sel, labelHas: padTimes(render(s.sel.labelHas, params)) } : s.sel;
    const node = await waitFor(sel, pkg, justLaunched ? 6000 : 4000);
    justLaunched = false;
    if (!node) return { ok: false, step: i, reason: `element not found: ${sel.labelHas || sel.resourceId}` };
    await phone.highlight(seen, node);

    if (s.op === 'tap') {
      if (s.external && !allowExternal) {
        await phone.highlight([], node, 10 * 60 * 1000); // keep the button marked while the person decides
        const allowed = confirm ? await confirm(s) : false;
        await phone.highlight([], null, 1);
        if (!allowed) return { ok: false, held: true, step: i, reason: `"${s.label}" was not allowed` };
      }
      say(`tap "${sel.labelHas || s.label}"`);
      await phone.tap(node);
      if (s.external) irreversible = true;
      await phone.settle(pkg);
    } else if (s.op === 'long_press') {
      say(`long press "${sel.labelHas || s.label}"`);
      await phone.nodeAction(node, 'long_click');
      await phone.sleep(500);
    } else if (s.op === 'type') {
      const text = render(s.text, params);
      say(`type "${text}" into "${s.sel.labelHas || s.label || "the field"}"`);
      await phone.typeInto(node, text);
      // Check the field took it; a field that was still animating in gets one more try.
      const again = await waitFor(sel, pkg, 800);
      if (again && !padTimes(phone.label(again)).toLowerCase().includes(padTimes(text).toLowerCase())) {
        await phone.settle(pkg);
        const fresh = await waitFor(sel, pkg, 1500);
        if (fresh) await phone.typeInto(fresh, text);
      }
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
  if (cap.sent) {
    // Something was typed and then sent: the text must now show outside the input field, as a sent message.
    const want = padTimes(render(cap.sent, params));
    for (let i = 0; i < 10; i++) {
      const screen = await phone.observe(pkg);
      if (screenHasText(screen.nodes.filter(n => !n.editable), want)) return { ok: true, verified: `"${want}" is on screen as sent` };
      await phone.sleep(300);
    }
    return { ok: false, irreversible, step: cap.steps.length, reason: `"${want}" did not appear outside the input field` };
  }
  if (cap.gone) {
    const gone = padTimes(render(cap.gone, params));
    for (let i = 0; i < 8; i++) {
      const screen = await phone.observe(pkg);
      if (!screenHasText(screen.nodes, gone)) return { ok: true, verified: `${gone} is gone` };
      await phone.sleep(300);
    }
    return { ok: false, irreversible, step: cap.steps.length, reason: `"${gone}" is still on screen` };
  }
  if (!cap.expect) return { ok: true, irreversible };
  const want = padTimes(render(cap.expect, params));
  // The screen has already settled, so two looks are enough before searching the list.
  for (let i = 0; i < 2; i++) {
    const screen = await phone.observe(pkg);
    if (screenHasText(screen.nodes, want)) return { ok: true, verified: want };
    await phone.sleep(300);
  }
  // The new item may sit below the visible part of a long list (a person with many alarms); look through it.
  if (await phone.findText(want, pkg)) return { ok: true, verified: want };
  return { ok: false, irreversible, step: cap.steps.length, reason: `"${want}" is not on screen after the last step` };
}
