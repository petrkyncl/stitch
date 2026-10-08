const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = v => (v === 0 ? '$0' : v < 0.01 ? '$' + v.toFixed(4) : '$' + v.toFixed(3));
const secs = ms => (ms / 1000).toFixed(1) + 's';

let state = null;
let taskStarted = 0;
let ticking = null;

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function logLine(kind, text, extra = '') {
  const li = document.createElement('li');
  li.className = kind === 'task' ? 'task' : kind === 'session' ? 'session' : '';
  li.innerHTML = kind === 'session' ? esc(text) : `<span class="k ${esc(kind)}">${esc(kind)}</span><span class="t">${esc(text)}${extra ? ` <span class="why">${esc(extra)}</span>` : ''}</span>`;
  $('log').append(li);
  $('log').scrollTop = $('log').scrollHeight;
}

function setMeter(m, final = false) {
  if (!m) return;
  $('mCalls').textContent = m.calls;
  $('mCost').textContent = money(m.cost);
  $('mTokens').textContent = `${m.tokensIn.toLocaleString()} tokens in, ${m.tokensOut.toLocaleString()} out`;
  if (final) $('mTime').textContent = secs(m.ms);
  document.querySelector('.meter').classList.toggle('zero', m.calls === 0);
}

function renderRuns() {
  const rows = state.runs.slice().reverse();
  $('runs').innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td class="n">${r.session}</td>
      <td>${esc(r.task)}${r.capability ? `<br><span class="muted mono">${esc(r.capability)}</span>` : ''}</td>
      <td><span class="pill ${esc(r.path)}">${esc(r.path)}</span></td>
      <td class="n">${secs(r.ms)}</td>
      <td class="n">${r.calls}</td>
      <td class="n">${money(r.cost)}</td>
    </tr>`).join('') : '<tr class="empty"><td colspan="6">No runs yet. Ask for something above.</td></tr>';
}

function renderRegistry() {
  const caps = state.capabilities;
  $('granted').textContent = `granted: ${state.granted.permissions.join(', ')}, effect ${state.granted.effects.join('/')}`;
  if (!caps.length) { $('registry').innerHTML = '<p class="muted">Empty. Stitch starts with only tap, type and read the screen.</p>'; return; }
  $('registry').innerHTML = caps.map(c => `
    <div class="cap">
      <div class="head"><span class="name">${esc(c.name)}(${esc(c.params.join(', '))}) v${c.version}</span><span class="pill ${esc(c.status)}">${esc(c.status === 'held' ? 'held for approval' : c.status)}</span></div>
      <div>${esc(c.description)}</div>
      <div class="meta"><span>${c.steps} steps</span><span>effect ${esc(c.effect)}</span><span>tests ${c.tests?.passed ?? 0}/${c.tests?.total ?? 0}</span><span>runs ${c.runs}</span></div>
      ${c.status === 'held' ? `<div class="meta">${esc(c.reason)}</div>` : ''}
      <div class="actions">
        ${c.status === 'held' ? `<button class="small" data-approve="${esc(c.name)}">Approve</button>` : ''}
        ${c.status === 'installed' ? `<button class="small ghost" data-break="${esc(c.name)}">Simulate app update</button>` : ''}
      </div>
    </div>`).join('');
}

async function refresh() {
  state = await api('/api/state');
  $('session').textContent = `Session ${state.session}`;
  $('model').textContent = state.hasKey ? state.model : 'no OpenAI key';
  $('model').className = 'chip mono ' + (state.hasKey ? '' : 'off');
  $('hands').textContent = state.hands ? 'Phone: accessibility' : 'Phone: adb dump';
  $('hands').className = 'chip ' + (state.hands ? 'on' : '');
  $('go').disabled = state.busy;
  renderRuns();
  renderRegistry();
}

const events = new EventSource('/api/events');
events.onmessage = e => {
  const ev = JSON.parse(e.data);
  if (ev.meter) setMeter(ev.meter);
  switch (ev.type) {
    case 'task':
      taskStarted = Date.now();
      clearInterval(ticking);
      ticking = setInterval(() => { $('mTime').textContent = secs(Date.now() - taskStarted); }, 100);
      $('go').disabled = true;
      logLine('task', ev.task);
      break;
    case 'step': logLine(ev.kind || 'step', ev.text, ev.why); break;
    case 'session': logLine('session', `New session ${ev.session}. Memory cleared, ${ev.capabilities} capabilities loaded from disk.`); refresh(); break;
    case 'run':
      clearInterval(ticking);
      setMeter(ev, true);
      refresh();
      break;
    case 'registry': refresh(); break;
    default: if (ev.text) logLine(ev.type, ev.text);
  }
};

$('taskForm').addEventListener('submit', async e => {
  e.preventDefault();
  const task = $('task').value.trim() || $('task').placeholder;
  try { await api('/api/task', { task }); $('task').value = ''; } catch (err) { logLine('error', err.message); }
});
$('examples').addEventListener('click', e => { if (e.target.matches('.ex')) { $('task').value = e.target.textContent; $('task').focus(); } });
$('newSession').addEventListener('click', () => api('/api/session').catch(err => logLine('error', err.message)));
$('registry').addEventListener('click', e => {
  const a = e.target.dataset.approve, b = e.target.dataset.break;
  if (a) api('/api/approve', { name: a }).then(refresh).catch(err => logLine('error', err.message));
  if (b) api('/api/break', { name: b }).then(() => { logLine('broken', `Simulated an app update that renamed a control used by ${b}`); refresh(); }).catch(err => logLine('error', err.message));
});

// Phone screen, refreshed while visible.
let screenTimer = null;
function pollScreen() {
  clearTimeout(screenTimer);
  if (!$('live').checked || document.hidden) return;
  const img = new Image();
  img.onload = () => { $('screen').src = img.src; screenTimer = setTimeout(pollScreen, 700); };
  img.onerror = () => { screenTimer = setTimeout(pollScreen, 2000); };
  img.src = '/api/screen.png?t=' + Date.now();
}
$('live').addEventListener('change', pollScreen);
document.addEventListener('visibilitychange', pollScreen);

refresh().then(pollScreen);
