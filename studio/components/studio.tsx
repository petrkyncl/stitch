"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { api, DEVICE, DEVICES } from "@/lib/engine";
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
  const { state, live, device, offline, sessions, now, epoch, refresh } = useEngine();
  const [task, setTask] = useState("");
  const [app, setApp] = useState<string | null>(null);
  const [error, setError] = useState("");
  const busy = state?.busy ?? false;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = task.trim();
    if (!text) return;
    setError("");
    try { await api("/api/task", { task: text, app: app ?? undefined }); setTask(""); recall.current = -1; } catch (err) { setError((err as Error).message); }
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
  const act = (path: string, body?: unknown) => api(path, body ?? {}).then(refresh).catch(err => setError(err.message));

  return (
    <div className="flex h-full min-h-0 flex-col text-base">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b-2 border-dashed border-thread px-8 py-4">
        <div className="flex items-baseline gap-4">
          <span className="font-display text-5xl leading-none font-black uppercase">Stitch</span>
          <span className="text-muted">grows new limbs, not new privileges</span>
        </div>
        <div className="flex flex-wrap items-center gap-3 font-mono text-sm">
          <DevicePicker />
          {offline && <Chip tone="bad">Engine offline</Chip>}
          <Chip>Session {state?.session ?? 1}</Chip>
          <Chip tone={state && !state.hasKey ? "bad" : undefined}>{state ? state.model : "model"}</Chip>
          <button type="button" onClick={() => act("/api/session")} disabled={busy}
            className="rounded-lg border border-line px-4 py-2 font-sans text-base font-medium hover:border-muted disabled:opacity-50">
            New session
          </button>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-8 px-8 py-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.7fr)] 2xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.8fr)_minmax(340px,0.75fr)]">
        <section className="flex min-h-0 flex-col gap-4" aria-label="Chat with the agent">
          <div className="min-h-0 flex-1 overflow-y-auto pr-2">
            <Chat runs={state?.runs ?? []} live={live} sessions={sessions} now={now} capabilities={state?.capabilities ?? []}
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
          <PhonePanel device={device} epoch={epoch} boxes={state?.boxes} />
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

// Which device this tab drives. Switching reloads the page onto that device's engine; open tabs to watch several.
function DevicePicker() {
  const current = useSyncExternalStore(() => () => {}, () => DEVICE.id, () => "phone");
  return (
    <label className="flex items-center gap-2">
      <span className="sr-only">Device</span>
      <select value={current} onChange={e => { window.location.search = e.target.value === "phone" ? "" : `?d=${e.target.value}`; }}
        className="rounded-lg border border-line bg-night-2 px-3 py-2 font-sans text-base hover:border-muted">
        {DEVICES.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
      </select>
    </label>
  );
}
