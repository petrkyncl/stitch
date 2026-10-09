"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, goTo, usePlace, type Run } from "@/lib/engine";
import { DeviceBar } from "./device-bar";
import { DeviceWall } from "./device-wall";
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
  const { device, view } = usePlace();
  if (view === "all") {
    return (
      <div className="flex h-full min-h-0 flex-col text-base">
        <Header><DeviceBar /></Header>
        <DeviceWall onOpen={id => goTo({ device: id, view: "one" })} />
      </div>
    );
  }
  // Keyed by device: switching starts a fresh workspace on that device's engine (its chat, state and live screen).
  return <Workspace key={device.id} />;
}

function Header({ children }: { children: React.ReactNode }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 border-b-2 border-dashed border-thread px-8 py-4">
      <div className="flex items-baseline gap-4">
        <span className="font-display text-5xl leading-none font-black uppercase">Stitch</span>
        <span className="text-muted">grows new limbs, not new privileges</span>
      </div>
      <div className="flex flex-wrap items-center gap-3 font-mono text-sm">{children}</div>
    </header>
  );
}

function Workspace() {
  const { state, live, device, offline, now, epoch, refresh } = useEngine();
  const [task, setTask] = useState("");
  const [app, setApp] = useState<string | null>(null);
  const [error, setError] = useState("");
  const busy = state?.busy ?? false;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = task.trim();
    if (!text) return;
    setError("");
    try { await api("/api/task", { task: text, app: app ?? undefined }); setTask(""); recall.current = -1; setViewing(null); } catch (err) { setError((err as Error).message); }
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
  const current = state?.session ?? 1;
  const shown = viewing ?? current;
  const act = (path: string, body?: unknown) => api(path, body ?? {}).then(refresh).catch(err => setError(err.message));

  return (
    <div className="flex h-full min-h-0 flex-col text-base">
      <Header>
        <DeviceBar />
        {offline && <Chip tone="bad">Engine offline</Chip>}
        <Chip tone={state && !state.hasKey ? "bad" : undefined}>
          {state ? (state.exploreModel && state.exploreModel !== state.model ? `learns with ${state.exploreModel}, runs on ${state.model}` : state.model) : "model"}
        </Chip>
      </Header>

      <div className="flex min-h-0 flex-1">
      <Sidebar runs={state?.runs ?? []} current={current} shown={shown} busy={busy}
        onPick={s => setViewing(s === current ? null : s)} onNew={() => { setViewing(null); act("/api/session"); }} />
      <main className="grid min-h-0 flex-1 grid-cols-1 gap-8 px-8 py-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.7fr)] 2xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.8fr)_minmax(340px,0.75fr)]">
        <section className="flex min-h-0 flex-col gap-4" aria-label="Chat with the agent">
          <div className="min-h-0 flex-1 overflow-y-auto pr-2">
            <Chat runs={(state?.runs ?? []).filter(r => r.session === shown)} live={shown === current ? live : null} sessions={[]} now={now} capabilities={state?.capabilities ?? []}
              pending={state?.pending ?? null} onDecide={decision => act("/api/permission", { decision })} />
          </div>
          <form onSubmit={submit} className="flex flex-col gap-1 rounded-2xl border border-line bg-night-2 px-3 pt-2.5 pb-2 transition-colors focus-within:border-dawn/50">
            <label htmlFor="task" className="sr-only">Ask the agent</label>
            <input id="task" value={task} onChange={e => { setTask(e.target.value); recall.current = -1; }} onKeyDown={onKey} autoComplete="off"
              placeholder={busy ? "Working on it. Esc stops." : "Ask the phone for something"}
              style={{ outline: "none" }} // the composer box shows focus, not the input inside it
              className="min-w-0 bg-transparent px-1 py-1.5 text-base text-flesh placeholder:text-muted/70" />
            <div className="flex items-center gap-2">
              <AppPicker value={app} onChange={setApp} />
              <Examples onPick={setTask} />
              {error && <span className="truncate text-sm text-thread">{error}</span>}
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

        <section className="flex min-h-[640px] flex-col lg:min-h-0" aria-label="Phone">
          <PhonePanel device={device} epoch={epoch} boxes={state?.boxes} offline={offline} />
        </section>

        <section className="min-h-0 overflow-y-auto lg:col-span-2 2xl:col-span-1" aria-label="Cost and capabilities">
          <Insights
            runs={state?.runs ?? []}
            capabilities={state?.capabilities ?? []}
            granted={state?.granted}
            onApprove={name => act("/api/approve", { name })}
            onRevoke={name => act("/api/revoke", { name })}
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

// The chats, ChatGPT style: a left sidebar with a new chat on top and every chat below, newest first. Each chat is a
// session (fresh memory; learned capabilities stay). Picking an older one shows it; asking continues the current one.
function Sidebar({ runs, current, shown, busy, onPick, onNew }: { runs: Run[]; current: number; shown: number; busy: boolean; onPick: (s: number) => void; onNew: () => void }) {
  const chats = new Map<number, Run[]>();
  for (const r of runs) chats.set(r.session, [...(chats.get(r.session) ?? []), r]);
  if (!chats.has(current)) chats.set(current, []);
  const list = [...chats.entries()].sort((a, b) => b[0] - a[0]);
  return (
    <aside aria-label="Chats" className="hidden w-64 shrink-0 flex-col gap-1 overflow-y-auto border-r border-line bg-night-2/40 px-3 py-4 lg:flex">
      <button type="button" onClick={onNew} disabled={busy}
        className="mb-3 flex items-center gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-night-3 disabled:opacity-50">
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" /></svg>
        New chat
      </button>
      <p className="px-3 pb-1 font-mono text-[11px] tracking-wider text-muted uppercase">Chats</p>
      {list.map(([s, rs]) => (
        <button key={s} type="button" onClick={() => onPick(s)} aria-current={s === shown ? "page" : undefined}
          title={rs[0]?.task ?? "New chat"}
          className={`flex flex-col rounded-lg px-3 py-2 text-left ${s === shown ? "bg-night-3 text-flesh" : "text-flesh/80 hover:bg-night-3/60"}`}>
          <span className="truncate text-sm">{rs[0]?.task ?? "New chat"}</span>
          <span className="text-xs text-muted">{rs.length ? `${rs.length} ${rs.length === 1 ? "task" : "tasks"} · ${new Date(rs[0].at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}` : "empty"}{s === current ? " · now" : ""}</span>
        </button>
      ))}
    </aside>
  );
}
