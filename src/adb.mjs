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

async function observeHands(pkg = '') {
  for (let i = 0; i < 5; i++) {
    try {
      const d = await hands('/tree' + (pkg ? `?pkg=${pkg}` : ''));
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
export async function observe(pkg = '') {
  if (await handsAvailable()) return observeHands(pkg);
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

// Put text into a field the way a person does: focus it, then type on the Stitch keyboard (an IME inside Hands).
// Falls back to accessibility SET_TEXT, then to adb key events, and checks the tree after each attempt.
const HUMAN_TYPING = process.env.HUMAN_TYPING === '1';

async function fieldShows(node, text) {
  const after = await observeHands();
  const same = after.nodes.find(n => n.resourceId === node.resourceId && Math.abs(n.cy - node.cy) < 40 && Math.abs(n.cx - node.cx) < 40)
    || after.nodes.find(n => n.focused && n.editable);
  return !!same && label(same).includes(String(text));
}

export async function typeInto(node, text) {
  if (node.gen !== undefined && await handsAvailable()) {
    try {
      await tap(node);
      for (let i = 0; i < 10; i++) {
        const ime = await hands('/ime');
        if (ime.ready) break;
        await sleep(80);
      }
      await hands('/ime/type', { text: String(text), replace: true, human: HUMAN_TYPING });
      await sleep(120);
      if (await fieldShows(node, text)) return 'keyboard';
    } catch { /* keyboard not active or no focus */ }
    try {
      const fresh = await observeHands();
      const again = fresh.nodes.find(n => n.resourceId === node.resourceId && Math.abs(n.cy - node.cy) < 40) || node;
      await hands('/settext', { id: again.id, gen: again.gen, text: String(text) });
      if (await fieldShows(node, text)) return 'settext';
    } catch { /* fall through */ }
  }
  await tap(node);
  await sleep(200);
  await typeText(text);
  return 'adb';
}

// Enter/Send/Search on the focused field, through the keyboard so the app's own action fires.
export async function pressEnter() {
  if (await handsAvailable()) {
    try { await hands('/ime/enter'); return; } catch { /* no keyboard */ }
  }
  await adb(['shell', 'input', 'keyevent', '66']);
}

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

// Whole-phone actions: back, home, recents, notifications, quick_settings, power_dialog, lock_screen, screenshot, split_screen.
export async function globalAction(name) {
  if (await handsAvailable()) return hands('/global', { action: name });
  const codes = { back: '4', home: '3', recents: '187' };
  if (codes[name]) return adb(['shell', 'input', 'keyevent', codes[name]]);
  if (name === 'notifications') return adb(['shell', 'cmd', 'statusbar', 'expand-notifications']);
  if (name === 'quick_settings') return adb(['shell', 'cmd', 'statusbar', 'expand-settings']);
  throw new Error(`${name} needs Stitch Hands`);
}

// Accessibility action on a node: long_click, scroll_forward, scroll_backward, expand, collapse, dismiss, ime_enter.
export async function nodeAction(node, action) {
  if (node.gen !== undefined && await handsAvailable()) return hands('/node', { id: node.id, gen: node.gen, action });
  if (action === 'ime_enter') return adb(['shell', 'input', 'keyevent', '66']);
  if (action === 'long_click') return adb(['shell', 'input', 'swipe', String(node.cx), String(node.cy), String(node.cx), String(node.cy), '700']);
  throw new Error(`${action} needs Stitch Hands`);
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

// Installed apps with the names people see, from Hands; package names only when Hands is not running.
let appsCache = { at: 0, list: null };
export async function installedApps() {
  if (appsCache.list && Date.now() - appsCache.at < 60000) return appsCache.list;
  let list;
  if (await handsAvailable()) {
    try { list = (await hands('/apps')).apps; } catch { /* fall back */ }
  }
  if (!list) list = (await launchableApps()).map(p => ({ package: p, label: p }));
  appsCache = { at: Date.now(), list };
  return list;
}

// "WhatsApp", "whatsapp" or "com.whatsapp" -> package name.
export async function resolveApp(nameOrPackage) {
  const q = String(nameOrPackage || '').trim().toLowerCase();
  const apps = await installedApps();
  return (apps.find(a => a.package.toLowerCase() === q) || apps.find(a => a.label.toLowerCase() === q)
    || apps.find(a => a.label.toLowerCase().startsWith(q)))?.package || null;
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
  await adb(['shell', 'cmd', 'statusbar', 'collapse']).catch(() => {}); // an open notification shade would hide the app
  const out = await adb(['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', pkg]);
  const comp = out.trim().split('\n').pop().trim();
  if (!comp.includes('/')) throw new Error(`No launcher activity for ${pkg}`);
  await adb(['shell', 'am', 'start', '-S', '-W', '-n', comp]);
}

export async function screenshot() {
  return adb(['exec-out', 'screencap', '-p'], { binary: true });
}

// Raw input from the studio (mouse on the live video), in device pixels.
export async function tapAt(x, y) {
  if (await handsAvailable()) return hands('/tap', { x, y });
  return adb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
}

export async function swipeAt(x1, y1, x2, y2, ms = 300) {
  if (await handsAvailable()) return hands('/swipe', { x1, y1, x2, y2, ms });
  return adb(['shell', 'input', 'swipe', ...[x1, y1, x2, y2].map(v => String(Math.round(v))), String(ms)]);
}

let deviceCache = { at: 0, info: null };

// Connection and device facts for the studio header: transport, model, Android, battery, screen.
export async function deviceInfo() {
  if (Date.now() - deviceCache.at < 4000 && deviceCache.info) return deviceCache.info;
  const info = { connected: false };
  try {
    const list = await new Promise((resolve, reject) => execFile(ADB, ['devices', '-l'], (e, out) => (e ? reject(e) : resolve(out))));
    const line = list.split('\n').find(l => (SERIAL ? l.startsWith(SERIAL) : /\sdevice\s/.test(l)) && /\sdevice\s/.test(l));
    if (line) {
      info.connected = true;
      info.serial = line.split(/\s+/)[0];
      info.transport = /usb:/.test(line) ? 'USB' : /:\d+$/.test(info.serial) ? 'Wi-Fi' : 'ADB';
      info.model = (line.match(/model:(\S+)/) || [])[1]?.replace(/_/g, ' ');
      const [release, battery, size] = await Promise.all([
        adb(['shell', 'getprop', 'ro.build.version.release']),
        adb(['shell', 'dumpsys', 'battery']),
        adb(['shell', 'wm', 'size']),
      ]);
      info.android = release.trim();
      info.battery = Number((battery.match(/level: (\d+)/) || [])[1]);
      info.charging = /AC powered: true|USB powered: true/.test(battery);
      const m = size.match(/(\d+)x(\d+)/g);
      const [w, h] = (m ? m[m.length - 1] : '1080x2340').split('x').map(Number);
      info.width = w; info.height = h;
      info.hands = await handsAvailable();
    }
  } catch (e) { info.error = e.message; }
  deviceCache = { at: Date.now(), info };
  return info;
}

// Scroll the current list until a text is visible: back to the top first, then down page by page.
// Stops when the screen no longer changes (end of the list). Returns the matching node or null.
export async function findText(text, pkg = '') {
  const want = String(text).toLowerCase();
  const visible = nodes => nodes.find(n => label(n).toLowerCase().includes(want) && n.cy > 150);
  const print = nodes => nodes.map(n => `${n.resourceId}|${label(n)}`).join('\n');
  let screen = await observe(pkg);
  let hit = visible(screen.nodes);
  if (hit) return hit;
  const W = 540;
  for (const [from, to, max] of [[700, 1700, 12], [1700, 700, 30]]) {
    let last = print(screen.nodes);
    for (let i = 0; i < max; i++) {
      await swipeAt(W, from, W, to, 250);
      await sleep(350);
      screen = await observe(pkg);
      hit = visible(screen.nodes);
      if (hit) return hit;
      const now = print(screen.nodes);
      if (now === last) break; // top or bottom reached
      last = now;
    }
  }
  return null;
}
