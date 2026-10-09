"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, DEVICES, engineUrl, usePlace, type Decision, type Run } from "@/lib/engine";
import { DeviceBar } from "./device-bar";
import { Fleet, EMULATORS } from "./fleet";
import { useEngine } from "./use-engine";
import { Chat } from "./chat";
import { PhonePanel } from "./phone-panel";
import { Insights } from "./insights";
import { AppPicker } from "./app-picker";

const EXAMPLES = [
  "Set an alarm for 7:14",
  "Find coffee in Google Maps",
  "Get 10 pizza places from Google Maps with rating and distance",
  "Send Petr Kyncl a WhatsApp message saying I am on my way",
];

export default function Studio() {
  const { device } = usePlace();
  // Keyed by device: switching starts a fresh workspace on that device's engine (its chat, state and live screen).
  return <Workspace key={device.id} />;
}

function Workspace() {
  const { state, live, device, offline, now, epoch, refresh } = useEngine();
  const { view, device: here } = usePlace();
  const fleet = view === "all";
  const [everyone, setEveryone] = useState(false); // "All emulators": learn on the selected one, then run on all
  const [note, setNote] = useState("");
  const [task, setTask] = useState("");
  const [app, setApp] = useState<string | null>(null);
  const [error, setError] = useState("");
  const busy = state?.busy ?? false;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = task.trim();
    if (!text) return;
    setError("");
    try {
      if (fleet && everyone) {
        // Learn once, then run everywhere: the selected emulator goes first (it learns the capability if it has to),
        // and only then do the others get the request, so they run it as code with no model calls.
        const body = JSON.stringify({ task: text, app: app ?? undefined });
        const send = (d: typeof here) => fetch(engineUrl(d) + "/api/task", { method: "POST", headers: { "content-type": "application/json" }, body })
          .then(r => { if (!r.ok) throw new Error(); });
        const others = EMULATORS.filter(d => d.id !== here.id);
        const before = state?.runs.length ?? 0;
        await api("/api/task", { task: text, app: app ?? undefined });
        setTask(""); recall.current = -1; setViewing(null);
        type Peek = { busy: boolean; current?: { events: { type: string }[] } | null; runs: { ok?: boolean }[] };
        const peek = () => api<Peek>("/api/state").catch(() => null);
        // Its first step tells whether it already knows how: then every emulator runs it at once. If it has to learn,
        // the others wait for that one capability instead of each learning (and paying) on its own.
        let learning = false;
        for (let i = 0; i < 25; i++) {
          await new Promise(r => setTimeout(r, 200));
          const s = await peek();
          const firstStep = s?.current?.events?.[0]?.type;
          if (firstStep) { learning = firstStep === "gap"; break; }
          if (s && !s.busy && s.runs.length > before) break; // already finished
        }
        if (!learning) {
          setNote(`Running on all ${others.length + 1}`);
          await Promise.allSettled(others.map(send));
          setTimeout(() => setNote(""), 5000);
          return;
        }
        setNote(`${here.label} is learning this. The other ${others.length} will run it as code once it works.`);
        const until = Date.now() + 6 * 60 * 1000;
        let first: { ok?: boolean } | undefined;
        for (;;) {
          await new Promise(r => setTimeout(r, 800));
          const s = await peek();
          if (s && !s.busy && s.runs.length > before) { first = s.runs.at(-1); break; }
          if (Date.now() > until) break;
        }
        // Only what worked is spread: a failure here would make every other emulator try (and pay) on its own.
        if (!first?.ok) { setNote(`It did not work on ${here.label}, so the others were not asked`); setTimeout(() => setNote(""), 6000); return; }
        setNote(`Learned. Now running on the other ${others.length} as code`);
        await Promise.allSettled(others.map(send));
        setTimeout(() => setNote(""), 5000);
        return;
      } else {
        await api("/api/task", { task: text, app: app ?? undefined });
      }
      setTask(""); recall.current = -1; setViewing(null);
    } catch (err) { setError((err as Error).message); }
  }
  const stop = () => api("/api/stop", {}).catch(err => setError(err.message));
  // Esc stops the agent, like stopping a person mid-task.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && busy) stop(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // Arrow up brings back what you asked before, newest first, like a terminal. Arrow down goes forward again.
  const recall = useRef(-1);
  // Newest first: the task running now, then finished runs by time. Each request once.
  const asked = [...new Set([live?.task, ...[...(state?.runs ?? [])].sort((a, b) => b.at - a.at).map(r => r.task)].filter((t): t is string => !!t))];
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (e.key === "ArrowUp" && task && recall.current === -1) return; // keep the cursor keys for a draft
    const next = e.key === "ArrowUp" ? Math.min(recall.current + 1, asked.length - 1) : Math.max(recall.current - 1, -1);
    if (next === recall.current) return;
    e.preventDefault();
    recall.current = next;
    setTask(next < 0 ? "" : asked[next]);
  };
  // Each session is a chat: a fresh memory, its own thread. Older chats can be read again; asking returns to the current one.
  const [viewing, setViewing] = useState<number | null>(null);
  const current = state?.chat ?? 1;
  const shown = viewing ?? current;
  const chatTitle = (state?.runs ?? []).find(r => (r.chat ?? 1) === shown)?.task ?? "New chat";
  // With the emulators, one answer covers every emulator that waits to be allowed the same capability.
  const decide = (decision: Decision) => {
    const capability = state?.pending?.capability;
    act("/api/permission", { decision });
    if (!fleet || !capability) return;
    for (const d of EMULATORS.filter(e => e.id !== here.id)) {
      fetch(engineUrl(d) + "/api/state").then(r => r.json())
        .then((s: { pending?: { capability?: string } | null }) => {
          if (s.pending?.capability === capability) {
            return fetch(engineUrl(d) + "/api/permission", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) });
          }
        }).catch(() => {});
    }
  };
  const act = (path: string, body?: unknown) => api(path, body ?? {}).then(refresh).catch(err => setError(err.message));

  return (
    <div className="flex h-full min-h-0 text-base">
      <Sidebar runs={state?.runs ?? []} current={current} shown={shown} busy={busy} models={state}
        onPick={s => setViewing(s === current ? null : s)} onNew={() => { setViewing(null); act("/api/session"); }} />
      <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line px-6">
        <span className="truncate font-medium">{chatTitle}</span>
        <div className="flex items-center gap-3 text-sm">
          {offline && <Chip tone="bad">Engine offline</Chip>}
          <DeviceBar />
        </div>
      </div>
      {/* With the emulators, their grid takes only the width the screens need and the chat gets the rest. */}
      <main className={`grid min-h-0 flex-1 grid-cols-1 ${fleet
        ? "gap-5 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_auto] 2xl:grid-cols-[minmax(0,1fr)_auto_minmax(280px,22rem)]"
        : "gap-8 px-8 py-6"
        + " lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.7fr)] 2xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.8fr)_minmax(340px,0.75fr)]"}`}>
        <section className="flex min-h-0 flex-col gap-4" aria-label="Chat with the agent">
          <div className="min-h-0 flex-1 overflow-y-auto pr-2">
            <Chat runs={(state?.runs ?? []).filter(r => (r.chat ?? 1) === shown)} live={shown === current ? live : null} sessions={[]} now={now} capabilities={state?.capabilities ?? []}
              pending={state?.pending ?? null} onDecide={decide} />
          </div>
          <form onSubmit={submit} className="flex flex-col gap-1 rounded-2xl border border-line bg-night-2 px-3 pt-2.5 pb-2 transition-colors focus-within:border-dawn/50">
            <label htmlFor="task" className="sr-only">Ask the agent</label>
            <input id="task" value={task} onChange={e => { setTask(e.target.value); recall.current = -1; }} onKeyDown={onKey} autoComplete="off"
              placeholder={busy ? "Working on it. Esc stops." : "Ask the phone for something"}
              style={{ outline: "none" }} // the composer box shows focus, not the input inside it
              className="min-w-0 bg-transparent px-1 py-1.5 text-base text-flesh placeholder:text-muted/70" />
            <div className="flex items-center gap-2">
              {fleet && (
                <div role="radiogroup" aria-label="Send to" className="flex rounded-lg border border-line p-0.5 text-sm">
                  <button type="button" role="radio" aria-checked={!everyone} onClick={() => setEveryone(false)}
                    className={`rounded-md px-2.5 py-0.5 ${!everyone ? "bg-night-3 text-flesh" : "text-muted hover:text-flesh"}`}>This emulator</button>
                  <button type="button" role="radio" aria-checked={everyone} onClick={() => setEveryone(true)}
                    className={`rounded-md px-2.5 py-0.5 ${everyone ? "bg-dawn font-medium text-night" : "text-muted hover:text-flesh"}`}>All emulators</button>
                </div>
              )}
              <AppPicker value={app} onChange={setApp} />
              <Examples onPick={setTask} />
              {error && <span className="truncate text-sm text-thread">{error}</span>}
              {note && <span className="truncate text-sm text-dawn">{note}</span>}
              <span className="flex-1" />
              {busy
                ? <button type="button" onClick={stop} title="Stop (Esc)" aria-label="Stop"
                    className="grid size-8 place-items-center rounded-full bg-flesh text-night hover:bg-thread">
                    <span className="size-2.5 rounded-[2px] bg-current" />
                  </button>
                : <button type="submit" disabled={!task.trim()} title="Send (Enter)" aria-label="Send"
                    className="grid size-8 place-items-center rounded-full bg-dawn text-night disabled:bg-night-3 disabled:text-muted">
                    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
                  </button>}
            </div>
          </form>
        </section>

        {fleet ? (
          <section className="min-h-[640px] lg:min-h-0" aria-label="Emulators"><Fleet /></section>
        ) : (
          <section className="flex min-h-[640px] flex-col lg:min-h-0" aria-label="Phone">
            <PhonePanel device={device} epoch={epoch} boxes={state?.boxes} offline={offline} />
          </section>
        )}

        {/* The capabilities are shared by every device, so they are on the right in both places. */}
        <section className="min-h-0 overflow-y-auto lg:col-span-2 2xl:col-span-1" aria-label="Cost and capabilities">
          <Insights
            runs={(state?.runs ?? []).filter(r => r.at >= (state?.resetAt ?? 0))}
            capabilities={state?.capabilities ?? []}
            granted={state?.granted}
            limits={state?.limits}
            onApprove={name => act("/api/approve", { name })}
            onRevoke={name => act("/api/revoke", { name })}
            onRollback={(name, version) => act("/api/rollback", { name, version })}
            onReset={() => api("/api/reset", {}).then(() => {
              // The registry is shared: every other device starts a new chat too and reads the now empty registry.
              for (const d of DEVICES) if (d.port !== here.port) fetch(engineUrl(d) + "/api/session", { method: "POST" }).catch(() => {});
              setViewing(null);
              refresh();
            }).catch(err => setError(err.message))}
            onBreak={name => act("/api/break", { name })}
          />
        </section>
      </main>
      </div>
    </div>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: "bad" }) {
  return <span className={`rounded-full border px-3 py-1 ${tone === "bad" ? "border-thread text-thread" : "border-line text-muted"}`}>{children}</span>;
}

// Example requests, tucked into a small menu so they do not crowd the composer.
function Examples({ onPick }: { onPick: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm text-muted hover:bg-night-3 hover:text-flesh">
        Examples <span aria-hidden className="text-xs">▾</span>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-40 mb-2 flex w-96 flex-col overflow-hidden rounded-xl border border-line bg-night-2 py-1 shadow-2xl">
          {EXAMPLES.map(x => (
            <button key={x} type="button" onClick={() => { onPick(x); setOpen(false); }} className="px-3 py-2 text-left text-sm hover:bg-night-3">{x}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// The chats, ChatGPT style: the name on top, a new chat, then every chat, newest first. A new chat also starts a
// fresh session (memory cleared; learned capabilities stay on disk). Picking an older chat shows it; asking always
// continues the current one.
function Sidebar({ runs, current, shown, busy, models, onPick, onNew }: {
  runs: Run[]; current: number; shown: number; busy: boolean; models: { model: string; exploreModel?: string } | null;
  onPick: (c: number) => void; onNew: () => void;
}) {
  const chats = new Map<number, Run[]>();
  for (const r of runs) chats.set(r.chat ?? 1, [...(chats.get(r.chat ?? 1) ?? []), r]);
  if (!chats.has(current)) chats.set(current, []);
  const list = [...chats.entries()].sort((a, b) => b[0] - a[0]);
  const name = (m?: string) => (m || "").replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/^./, c => c.toUpperCase());
  return (
    <aside aria-label="Chats" className="hidden w-64 shrink-0 flex-col border-r border-line bg-night-2/40 lg:flex">
      <div className="flex h-14 shrink-0 items-center px-5">
        <span className="font-display text-2xl leading-none font-black">Stitch</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-3">
        <button type="button" onClick={onNew} disabled={busy}
          className="mb-4 flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-night-3 disabled:opacity-50">
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" /></svg>
          New chat
        </button>
        <p className="px-3 pb-1.5 text-xs text-muted">Chats</p>
        {list.map(([c, rs]) => (
          <button key={c} type="button" onClick={() => onPick(c)} aria-current={c === shown ? "page" : undefined} title={rs[0]?.task ?? "New chat"}
            className={`truncate rounded-lg px-3 py-2 text-left text-sm ${c === shown ? "bg-night-3 text-flesh" : "text-flesh/80 hover:bg-night-3/60"}`}>
            {rs[0]?.task ?? "New chat"}
          </button>
        ))}
      </div>
      {models?.model && (
        <p className="border-t border-line px-5 py-3 text-xs text-muted">
          {models.exploreModel && models.exploreModel !== models.model ? <>Learns with {name(models.exploreModel)}<br />Runs on {name(models.model)}</> : name(models.model)}
        </p>
      )}
    </aside>
  );
}
