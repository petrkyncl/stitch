"use client";

import { useState, type FormEvent } from "react";
import { api } from "@/lib/engine";
import { useEngine } from "./use-engine";
import { Log } from "./log";
import { Meter } from "./meter";
import { Runs } from "./runs";
import { Registry } from "./registry";
import { Phone } from "./phone";

const EXAMPLES = ["Set an alarm for 7:14", "Set an alarm for 6:30", "Wake me up at 5:45"];

export default function Studio() {
  const { state, log, meter, elapsed, offline, refresh, push } = useEngine();
  const [task, setTask] = useState("");
  const busy = state?.busy ?? false;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = task.trim() || EXAMPLES[0];
    try {
      await api("/api/task", { task: text });
      setTask("");
    } catch (err) {
      push("error", (err as Error).message);
    }
  }

  const act = (path: string, body?: unknown) => api(path, body ?? {}).then(refresh).catch(err => push("error", err.message));

  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-dashed border-thread px-5 py-3">
        <div className="flex items-baseline gap-3">
          <span className="font-display text-4xl leading-none font-black uppercase">Stitch</span>
          <span className="font-mono text-xs tracking-[.14em] text-muted uppercase">studio</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
          {offline && <Chip tone="bad">Engine offline</Chip>}
          <Chip>Session {state?.session ?? 1}</Chip>
          <Chip tone={state?.hands ? "good" : undefined}>{state?.hands ? "Phone: accessibility" : "Phone: adb dump"}</Chip>
          <Chip tone={state && !state.hasKey ? "bad" : undefined}>{state?.hasKey ? state.model : "No OpenAI key"}</Chip>
          <button
            type="button"
            onClick={() => act("/api/session")}
            disabled={busy}
            className="rounded border border-line px-3 py-1.5 font-sans text-sm font-medium text-flesh hover:border-muted disabled:opacity-50"
          >
            New session
          </button>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-5 p-5 md:grid-cols-2 xl:grid-cols-[minmax(0,1.1fr)_minmax(260px,.75fr)_minmax(0,1.2fr)]">
        <section className="flex min-h-0 min-w-0 flex-col gap-3" aria-label="Task and live log">
          <form onSubmit={submit} className="flex flex-col gap-2.5">
            <label htmlFor="task" className="font-mono text-[11px] tracking-[.14em] text-thread uppercase">Ask the agent</label>
            <div className="flex gap-2">
              <input
                id="task"
                value={task}
                onChange={e => setTask(e.target.value)}
                placeholder={EXAMPLES[0]}
                autoComplete="off"
                className="min-w-0 flex-1 rounded border border-line bg-night-2 px-3.5 py-2.5 text-lg font-medium text-flesh placeholder:text-muted/60"
              />
              <button type="submit" disabled={busy} className="rounded bg-dawn px-5 font-semibold text-night disabled:cursor-progress disabled:opacity-50">
                {busy ? "Working" : "Run"}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map(x => (
                <button key={x} type="button" onClick={() => setTask(x)} className="rounded border border-line bg-night-2 px-2.5 py-1 text-[13px] text-muted hover:text-flesh">
                  {x}
                </button>
              ))}
            </div>
          </form>
          <div className="font-mono text-[11px] tracking-[.14em] text-thread uppercase">Live</div>
          <Log lines={log} />
        </section>

        <section className="flex min-w-0 flex-col items-center gap-3 md:row-span-2 xl:row-span-1" aria-label="Phone screen">
          <Phone />
        </section>

        <section className="flex min-h-0 min-w-0 flex-col gap-5 overflow-y-auto" aria-label="Cost and capabilities">
          <Meter meter={meter} elapsed={elapsed} busy={busy} />
          <Runs runs={state?.runs ?? []} />
          <Registry
            capabilities={state?.capabilities ?? []}
            granted={state?.granted}
            onApprove={name => act("/api/approve", { name })}
            onBreak={name => { push("broken", `Simulated an app update that renamed a control used by ${name}`); act("/api/break", { name }); }}
          />
        </section>
      </main>
    </>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: "good" | "bad" }) {
  const color = tone === "good" ? "border-ok text-ok" : tone === "bad" ? "border-thread text-thread" : "border-line text-muted";
  return <span className={`rounded-full border px-2.5 py-0.5 ${color}`}>{children}</span>;
}
