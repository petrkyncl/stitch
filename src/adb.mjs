// Thin ADB bridge: read the UI tree, tap, type, launch apps, take screenshots.
import { execFile } from 'node:child_process';

const ADB = process.env.ADB || 'adb';
const SERIAL = process.env.ANDROID_SERIAL || '';

function adb(args, { binary = false, timeout = 20000 } = {}) {
  const full = SERIAL ? ['-s', SERIAL, ...args] : args;
  return new Promise((resolve, reject) => {
    execFile(ADB, full, { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`adb ${args.join(' ')}: ${String(stderr || err.message).trim()}`));
      resolve(stdout);
    });
  });
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

const ATTRS = ['text', 'resource-id', 'class', 'package', 'content-desc', 'clickable', 'enabled', 'focused', 'scrollable', 'checked', 'selected', 'bounds'];

function decode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export function parseNodes(xml) {
  const nodes = [];
  for (const m of xml.matchAll(/<node\s([^>]*?)\/?>/g)) {
    const raw = {};
    for (const a of ATTRS) {
      const v = m[1].match(new RegExp(`\\s?${a}="([^"]*)"`));
      raw[a] = v ? decode(v[1]) : '';
    }
    const b = raw.bounds.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    if (x2 <= x1 || y2 <= y1) continue;
    nodes.push({
      id: nodes.length,
      text: raw.text,
      resourceId: raw['resource-id'],
      cls: raw.class.split('.').pop(),
      pkg: raw.package,
      desc: raw['content-desc'],
      clickable: raw.clickable === 'true',
      editable: /EditText|AutoCompleteTextView/.test(raw.class),
      scrollable: raw.scrollable === 'true',
      checked: raw.checked === 'true',
      selected: raw.selected === 'true',
      focused: raw.focused === 'true',
      bounds: [x1, y1, x2, y2],
      cx: Math.round((x1 + x2) / 2),
      cy: Math.round((y1 + y2) / 2),
    });
  }
  return nodes;
}

// Stitch Hands: accessibility service on the phone, reached through `adb forward`. ~20 ms per screen
// instead of ~2.5 s for a uiautomator dump. Falls back to the dump when it is not running.
const HANDS = 'http://127.0.0.1:7912';
let handsReady = null;

async function hands(path, body) {
  const res = await fetch(HANDS + path, body ? { method: 'POST', body: JSON.stringify(body) } : {});
  const data = await res.json();
  if (data.ok === false) throw new Error(`hands ${path}: ${data.error}`);
  return data;
}

export async function handsAvailable() {
  if (handsReady !== null) return handsReady;
  try {
    await adb(['forward', 'tcp:7912', 'tcp:7912']);
    await hands('/ping');
    handsReady = true;
  } catch { handsReady = false; }
  return handsReady;
}

async function observeHands() {
  for (let i = 0; i < 5; i++) {
    try {
      const d = await hands('/tree');
      const nodes = d.nodes.map(n => {
        const [x1, y1, x2, y2] = n.bounds;
        return {
          id: n.id, gen: d.gen, text: n.text, resourceId: n.rid, cls: n.cls, pkg: n.pkg, desc: n.desc,
          clickable: n.clickable, editable: n.editable || /EditText/.test(n.cls), scrollable: n.scrollable,
          checked: n.checked, selected: false, focused: n.focused, bounds: n.bounds,
          cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2),
        };
      });
      return { nodes, pkg: d.pkg, at: Date.now(), via: 'hands' };
    } catch (e) {
      if (i === 4) throw e;
      await sleep(120);
    }
  }
}

// One screen observation. uiautomator sometimes fails mid-animation, so retry.
export async function observe() {
  if (await handsAvailable()) return observeHands();
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const out = await adb(['exec-out', 'uiautomator', 'dump', '/dev/tty']);
      const xml = out.slice(out.indexOf('<?xml'), out.lastIndexOf('</hierarchy>') + 12);
      if (!xml.startsWith('<?xml')) throw new Error('empty UI dump');
      const nodes = parseNodes(xml);
      const pkg = nodes.find(n => n.pkg && n.pkg !== 'com.android.systemui')?.pkg || nodes[0]?.pkg || '';
      return { nodes, pkg, at: Date.now() };
    } catch (e) {
      lastErr = e;
      await sleep(300);
    }
  }
  throw lastErr;
}

export const label = n => n.text || n.desc || '';

export async function tap(node) {
  if (node.gen !== undefined && await handsAvailable()) {
    try { await hands('/click', { id: node.id, gen: node.gen }); return; } catch { /* stale tree, use coordinates */ }
  }
  await adb(['shell', 'input', 'tap', String(node.cx), String(node.cy)]);
}

// Put text into a field. Accessibility SET_TEXT first; some widgets (Samsung's number picker) ignore it,
// so check the tree and fall back to tapping the field and typing on the keyboard.
export async function typeInto(node, text) {
  if (node.gen !== undefined && await handsAvailable()) {
    try {
      await hands('/settext', { id: node.id, gen: node.gen, text: String(text) });
      const after = await observeHands();
      const same = after.nodes.find(n => n.resourceId === node.resourceId && Math.abs(n.cy - node.cy) < 20 && Math.abs(n.cx - node.cx) < 20);
      if (same && label(same).includes(String(text))) return 'settext';
    } catch { /* fall through */ }
  }
  await tap(node);
  await sleep(200);
  await typeText(text);
  return 'keyboard';
}

// `input text` treats spaces and shell characters specially.
export async function typeText(text) {
  const safe = String(text)
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/([\\'"`$&|;<>()*?!#~{}[\]])/g, '\\$1')
    .replace(/ /g, '%s');
  if (safe) await adb(['shell', 'input', 'text', safe]);
}

export async function clearField(node) {
  await tap(node);
  await adb(['shell', 'input', 'keycombination', '113', '29']).catch(() => {}); // ctrl+a
  await adb(['shell', 'input', 'keyevent', '67']); // delete
}

export async function key(name) {
  if ((name === 'back' || name === 'home') && await handsAvailable()) {
    try { await hands('/global', { action: name }); return; } catch { /* use keyevent */ }
  }
  const codes = { back: '4', home: '3', enter: '66' };
  await adb(['shell', 'input', 'keyevent', codes[name] || name]);
}

export async function scroll(direction = 'down') {
  const [x, a, b] = direction === 'down' ? [540, 1700, 700] : [540, 700, 1700];
  await adb(['shell', 'input', 'swipe', String(x), String(a), String(x), String(b), '300']);
}

export async function launchableApps() {
  const out = await adb(['shell', 'cmd', 'package', 'query-activities', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER']);
  const pkgs = new Set();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^([\w.]+)\/[\w.$]+$/);
    if (m) pkgs.add(m[1]);
  }
  return [...pkgs].sort();
}

// Fresh start of an app's launcher activity, so every run begins from the same screen.
export async function launch(pkg) {
  const out = await adb(['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', pkg]);
  const comp = out.trim().split('\n').pop().trim();
  if (!comp.includes('/')) throw new Error(`No launcher activity for ${pkg}`);
  await adb(['shell', 'am', 'start', '-S', '-W', '-n', comp]);
}

export async function screenshot() {
  return adb(['exec-out', 'screencap', '-p'], { binary: true });
}
