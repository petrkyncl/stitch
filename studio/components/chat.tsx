"use client";

import { useEffect, useRef, useState } from "react";
import { money, secs, type Run, type RunEvent } from "@/lib/engine";

type Turn = { kind: "run"; run: Run; live: boolean } | { kind: "session"; session: number; at: number; capabilities: number };

const OUTCOME: Record<string, { label: string; tone: string }> = {
  learned: { label: "Learned a new capability", tone: "text-dawn border-dawn/60" },
  code: { label: "Ran an installed capability as code", tone: "text-ok border-ok/60" },
  repaired: { label: "Repaired and installed a new version", tone: "text-dawn border-dawn/60" },
  held: { label: "Held for a person's approval", tone: "text-thread border-thread/60" },
  failed: { label: "Did not finish", tone: "text-thread border-thread/60" },
  working: { label: "Working", tone: "text-flesh border-line" },
};

const DOT: Record<string, string> = {
  explore: "bg-muted", run: "bg-ok", gap: "bg-dawn", compile: "bg-dawn", test: "bg-flesh", install: "bg-ok", done: "bg-ok",
  route: "bg-ok", use: "bg-ok", broken: "bg-dawn", blocked: "bg-thread", held: "bg-thread", error: "bg-thread",
};

export function Chat({ runs, live, sessions, now }: { runs: Run[]; live: Run | null; sessions: { session: number; at: number; capabilities: number }[]; now: number }) {
  const end = useRef<HTMLDivElement>(null);
  const turns: Turn[] = [
    ...runs.map(r => ({ kind: "run" as const, run: r, live: false })),
    ...(live ? [{ kind: "run" as const, run: live, live: true }] : []),
    ...sessions.map(s => ({ kind: "session" as const, ...s })),
  ].sort((a, b) => (a.kind === "run" ? a.run.at : a.at) - (b.kind === "run" ? b.run.at : b.at));

  const liveCount = live?.events.length ?? 0;
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [turns.length, liveCount]);

  if (!turns.length) {
    return (
      <div className="grid flex-1 place-items-center px-6 text-center">
        <div className="flex max-w-md flex-col gap-3">
          <p className="font-display text-4xl font-black uppercase">Ask for something it can&apos;t do yet</p>
          <p className="text-muted">Stitch starts with only tap, type and read the screen. The first time, it explores the app and writes the capability. Every time after, it runs that code with zero model calls.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 px-1 py-2">
      {turns.map(t => t.kind === "session"
        ? <SessionMark key={`s${t.session}`} session={t.session} capabilities={t.capabilities} />
        : <Exchange key={t.run.id} run={t.run} live={t.live} now={now} />)}
      <div ref={end} />
    </div>
  );
}

function SessionMark({ session, capabilities }: { session: number; capabilities: number }) {
  return (
    <div className="flex items-center gap-4 font-mono text-sm text-dawn">
      <span className="h-px flex-1 border-t border-dashed border-line" />
      <span>Session {session}: memory cleared, {capabilities} {capabilities === 1 ? "capability" : "capabilities"} loaded from disk</span>
      <span className="h-px flex-1 border-t border-dashed border-line" />
    </div>
  );
}

function Exchange({ run, live, now }: { run: Run; live: boolean; now: number }) {
  const outcome = OUTCOME[live ? "working" : run.path || "failed"];
  const elapsed = live ? now - run.at : run.ms;
  const proof = [...run.events].reverse().find(e => e.type === "done" || (e.type === "test" && /passed/i.test(e.text || "")));
  return (
    <div className="flex flex-col gap-3">
      <div className="self-end rounded-2xl rounded-br-sm bg-night-3 px-5 py-3 text-lg font-medium">{run.task}</div>

      <div className="flex max-w-[52rem] flex-col gap-4 rounded-2xl rounded-bl-sm border border-line bg-night-2 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className={`flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-xs tracking-wider uppercase ${outcome.tone}`}>
            {live && <span className="size-2 animate-pulse rounded-full bg-dawn" />}
            {outcome.label}
          </span>
          {run.capability && <span className="font-mono text-sm text-muted">{run.capability}</span>}
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat value={secs(elapsed)} label="time" />
          <Stat value={String(run.calls)} label="model calls" accent={!live && run.calls === 0} />
          <Stat value={money(run.cost)} label="cost" accent={!live && run.cost === 0} />
          <Stat value={(run.tokensIn + run.tokensOut).toLocaleString()} label="tokens" />
        </div>

        {proof && <p className="text-ok">{proof.text}</p>}
        {run.error && <p className="text-thread">{run.error}</p>}

        <Steps events={run.events} open={live} />
      </div>
    </div>
  );
}

function Stat({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className={`font-display text-4xl leading-none font-black tabular-nums ${accent ? "text-ok" : "text-flesh"}`}>{value}</span>
      <span className="mt-1 font-mono text-xs text-muted">{label}</span>
    </div>
  );
}

function Steps({ events, open }: { events: RunEvent[]; open: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const show = open || expanded;
  const visible = show ? events : events.slice(-3);
  if (!events.length) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <ol className="flex flex-col gap-1.5">
        {visible.map((e, i) => (
          <li key={i} className="grid grid-cols-[14px_84px_minmax(0,1fr)] items-baseline gap-2 text-[15px]">
            <span className={`size-2 translate-y-[-1px] rounded-full ${DOT[e.kind || e.type] || "bg-muted"}`} />
            <span className="font-mono text-xs tracking-wider text-muted uppercase">{e.kind || e.type}</span>
            <span className="break-words">{e.text}{e.why && <span className="text-muted"> · {e.why}</span>}</span>
          </li>
        ))}
      </ol>
      {!open && events.length > 3 && (
        <button type="button" onClick={() => setExpanded(x => !x)} className="self-start font-mono text-xs text-muted underline-offset-4 hover:text-flesh hover:underline">
          {expanded ? "Show fewer steps" : `Show all ${events.length} steps`}
        </button>
      )}
    </div>
  );
}
