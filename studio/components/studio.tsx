"use client";

import { useState, type FormEvent } from "react";
import { api } from "@/lib/engine";
import { useEngine } from "./use-engine";
import { Chat } from "./chat";
import { PhonePanel } from "./phone-panel";
import { Insights } from "./insights";

const EXAMPLES = ["Set an alarm for 7:14", "Set an alarm for 6:30", "Wake me up at 5:45"];

export default function Studio() {
  const { state, live, device, offline, sessions, now, refresh } = useEngine();
  const [task, setTask] = useState("");
  const [error, setError] = useState("");
  const busy = state?.busy ?? false;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = task.trim();
    if (!text) return;
    setError("");
    try { await api("/api/task", { task: text }); setTask(""); } catch (err) { setError((err as Error).message); }
  }
  const act = (path: string, body?: unknown) => api(path, body ?? {}).then(refresh).catch(err => setError(err.message));

  return (
    <div className="flex h-full min-h-0 flex-col text-base">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b-2 border-dashed border-thread px-8 py-4">
        <div className="flex items-baseline gap-4">
          <span className="font-display text-5xl leading-none font-black uppercase">Stitch</span>
          <span className="text-muted">grows new limbs, not new privileges</span>
        </div>
        <div className="flex flex-wrap items-center gap-3 font-mono text-sm">
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
            <Chat runs={state?.runs ?? []} live={live} sessions={sessions} now={now} />
          </div>
          <form onSubmit={submit} className="flex flex-col gap-3 rounded-2xl border border-line bg-night-2 p-3">
            <div className="flex gap-3">
              <label htmlFor="task" className="sr-only">Ask the agent</label>
              <input id="task" value={task} onChange={e => setTask(e.target.value)} autoComplete="off"
                placeholder="Ask the phone for something, e.g. Set an alarm for 7:14"
                className="min-w-0 flex-1 bg-transparent px-3 py-2 text-lg text-flesh outline-none placeholder:text-muted/70" />
              <button type="submit" disabled={busy || !task.trim()} className="rounded-xl bg-dawn px-6 text-lg font-semibold text-night disabled:opacity-40">
                {busy ? "Working" : "Send"}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2 px-1">
              {EXAMPLES.map(x => (
                <button key={x} type="button" onClick={() => setTask(x)} className="rounded-full border border-line px-3 py-1 text-sm text-muted hover:text-flesh">{x}</button>
              ))}
              {error && <span className="text-sm text-thread">{error}</span>}
            </div>
          </form>
        </section>

        <section className="flex min-h-[640px] flex-col lg:min-h-0" aria-label="Phone">
          <PhonePanel device={device} />
        </section>

        <section className="min-h-0 overflow-y-auto lg:col-span-2 2xl:col-span-1" aria-label="Cost and capabilities">
          <Insights
            runs={state?.runs ?? []}
            capabilities={state?.capabilities ?? []}
            granted={state?.granted}
            onApprove={name => act("/api/approve", { name })}
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
