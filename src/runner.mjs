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

const MAX_ROUNDS = Number(process.env.MAX_ROUNDS_PER_RUN || 100); // the cap on repeating "all of them"

// `confirm(step)` is asked right before a step that sends, pays or deletes, with everything before it already
// done on screen, so the person sees exactly what would go out. Without it such a step holds the run.
// `from` and `pkg` start it part way, on a screen that is already prepared (right after learning, the message is
// typed and only the send is left).
// A long message is named by its start in the result line, not repeated in full.
const brief = t => { const one = String(t).replace(/\s+/g, ' ').trim(); return one.length > 60 ? `${one.slice(0, 57)}...` : one; };

export async function run(cap, params, { emit, allowExternal = false, confirm = null, from = 0, pkg: startPkg = '', stopAt = -1 }) {
  let pkg = startPkg;
  let justLaunched = false;
  let irreversible = false; // set once a step that sends, pays or deletes has run
  let before = new Set(); // texts on screen right before that step
  // "All of them": after a round, go back to the step that picks an item while one is left (capped in code).
  const itemAt = cap.repeat ? cap.steps.findIndex(st => st.item) : -1;
  let rounds = 0;
  let retried = false; // one second try per run when an item does not open as expected
  // Fields typed on this screen. An app can still fill in its defaults after we typed (Samsung Clock resets the hour
  // while its alarm screen opens), so each is checked again before the tap that saves or sends them.
  let filled = [];
  let start = from;
  for (;;) {
  for (let i = start; i < cap.steps.length; i++) {
    const s = cap.steps[i];
    const say = text => emit('step', { kind: 'run', text });

    if (s.op === 'launch') {
      filled = [];
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
      filled = []; // enter submits what was typed
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
    let node = await waitFor(sel, pkg, justLaunched ? 6000 : 4000);
    // The row the input picks (a contact, an alarm) may sit further down the list: look through it before giving up.
    if (!node && sel.templated && sel.labelHas && await phone.findText(sel.labelHas, pkg)) node = await waitFor(sel, pkg, 1000);
    justLaunched = false;
    if (!node) {
      // A one-time dialog (terms, a tip) that was there while learning and is not now: skip it when the next step's
      // element is already on screen.
      const next = cap.steps[i + 1];
      if (s.op === 'tap' && next?.sel && !next.sel.templated && findBySelector((await phone.observe(pkg)).nodes, next.sel)) {
        say(`skip "${s.label || sel.labelHas}": not shown this time`);
        continue;
      }
      // In a later round of "all of them", no item to pick means none is left: that is the goal, not a failure.
      if (s.item && rounds > 0) return { ok: true, irreversible, verified: `none left after ${rounds} ${rounds === 1 ? 'round' : 'rounds'}` };
      // Later in a round (the item did not open the way it did when learned): go back and pick it once more; if that
      // fails too, say plainly how far it got.
      if (itemAt >= 0 && i > itemAt && rounds > 0 && !retried) {
        retried = true;
        say(`"${s.label || sel.labelHas}" did not appear, picking the item again`);
        await phone.globalAction('back').catch(() => {});
        await phone.settle(pkg, 1500);
        i = itemAt - 1;
        continue;
      }
      if (itemAt >= 0 && rounds > 0) return { ok: false, irreversible, step: i, reason: `did ${rounds} of them, then "${s.label || sel.labelHas}" did not appear for the next one, so some are left` };
      return { ok: false, irreversible, step: i, reason: `element not found: ${sel.labelHas || sel.resourceId}` };
    }
    await phone.highlight(seen, node);

    if (s.item) say(`pick "${phone.label(node) || 'the next one'}"`); // the item this round acts on
    if (s.op === 'tap') {
      if (s.external && !allowExternal) {
        await phone.highlight([], node, 10 * 60 * 1000); // keep the button marked while the person decides
        const allowed = confirm ? await confirm(s) : false;
        await phone.highlight([], null, 1);
        if (!allowed) return { ok: false, held: true, step: i, reason: `"${s.label}" was not allowed` };
        allowExternal = true; // one yes covers this whole request, every round of it
      }
      let retyped = false;
      for (const f of filled) {
        const field = await waitFor(f.sel, pkg, 300);
        if (field && !padTimes(phone.label(field)).toLowerCase().includes(padTimes(f.text).toLowerCase())) {
          say(`"${f.text}" was replaced by the app, typing it again`);
          await phone.typeInto(field, f.text);
          await phone.settle(pkg, 1200);
          retyped = true;
        }
      }
      filled = [];
      // A test stops before the step that saves or sends; the run that follows presses it on this prepared screen.
      if (i === stopAt) return { ok: false, held: true, step: i, reason: `stopped before "${s.label || sel.labelHas}"` };
      if (retyped) node = await waitFor(sel, pkg, 1000) || node; // the screen was touched since it was found
      say(`tap "${sel.labelHas || s.label}"`);
      if (s.external) before = new Set(seen.map(phone.label).filter(Boolean)); // to tell the answer from what was there
      await phone.tap(node);
      if (s.external) irreversible = true;
      await phone.settle(pkg);
    } else if (s.op === 'long_press') {
      say(`long press "${s.item ? phone.label(node) : sel.labelHas || s.label}"`);
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
      filled.push({ sel, text });
      await phone.settle(pkg, 1200); // a send button often turns on only once the app has seen the new text
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
    if (itemAt < 0) break;
    rounds += 1;
    await phone.settle(pkg, 1500);
    const left = findBySelector((await phone.observe(pkg)).nodes, cap.steps[itemAt].sel);
    if (!left) return { ok: true, irreversible, verified: `none left after ${rounds} ${rounds === 1 ? 'round' : 'rounds'}` };
    if (rounds >= MAX_ROUNDS) return { ok: false, irreversible, step: itemAt, reason: `stopped at the cap of ${MAX_ROUNDS} rounds with some left` };
    emit('step', { kind: 'run', text: `Round ${rounds} done, more left, going again` });
    start = itemAt;
  }
  if (cap.sent) {
    // Something was typed and then sent: the text must now show outside the input field, as a sent message.
    const want = padTimes(render(cap.sent, params));
    // A first message can take a while to show: Claude opens a new conversation for it first.
    for (const end = Date.now() + 12000; Date.now() < end;) {
      const screen = await phone.observe(pkg);
      if (screenHasText(screen.nodes.filter(n => !n.editable), want)) {
        if (!cap.reply) return { ok: true, verified: `"${brief(want)}" is on screen as sent` };
        emit('step', { kind: 'run', text: 'waiting for the answer' });
        const reply = await readReply(pkg, before, params);
        return { ok: true, verified: `"${brief(want)}" is on screen as sent`, reply };
      }
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

// What an app answers after a send (a chatbot reply): the longest new text on screen and the paragraphs right next
// to it. Only real text counts (icon buttons such as "Copy message" carry just a description), nothing that was there
// before, nothing typed. Chat apps write the answer out bit by bit, so wait until it stops changing.
async function readReply(pkg, before, params) {
  const typed = Object.values(params || {}).map(v => String(v).trim().toLowerCase());
  let last = '';
  let steady = 0;
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    const { nodes } = await phone.observe(pkg);
    const fresh = nodes
      .filter(n => n.text && !n.clickable && !n.editable && !before.has(n.text) && n.text.trim().length > 2 && !typed.includes(n.text.trim().toLowerCase()))
      .sort((a, b) => a.bounds[1] - b.bounds[1]);
    const text = block(fresh);
    if (text && text === last) { if (++steady >= 3) return text; } else { steady = 0; last = text; }
    await phone.sleep(700);
  }
  return last;
}

// The longest text and its neighbours above and below that start in the same column with little space between.
function block(sorted) {
  if (!sorted.length) return '';
  const at = sorted.reduce((best, n, i) => (n.text.length > sorted[best].text.length ? i : best), 0);
  const near = (a, b) => Math.abs(a.bounds[0] - b.bounds[0]) < 80 && b.bounds[1] - a.bounds[3] < 90;
  let lo = at, hi = at;
  while (lo > 0 && near(sorted[lo - 1], sorted[lo])) lo -= 1;
  while (hi < sorted.length - 1 && near(sorted[hi], sorted[hi + 1])) hi += 1;
  return sorted.slice(lo, hi + 1).map(n => n.text.trim()).join('\n');
}
