"use client";

import { useEffect, useRef, useState } from "react";
import { ENGINE, money, secs, type Decision, type Pending, type Run, type RunEvent } from "@/lib/engine";
import { AppIcon } from "./app-picker";

type Turn = { kind: "run"; run: Run; live: boolean } | { kind: "session"; session: number; at: number; capabilities: number };

const OUTCOME: Record<string, { label: string; tone: string }> = {
  learned: { label: "Learned a new capability", tone: "text-dawn border-dawn/60" },
  code: { label: "Ran an installed capability as code", tone: "text-ok border-ok/60" },
  repaired: { label: "Repaired and installed a new version", tone: "text-dawn border-dawn/60" },
  held: { label: "Not done without your permission", tone: "text-thread border-thread/60" },
  failed: { label: "Did not finish", tone: "text-thread border-thread/60" },
  stopped: { label: "Stopped by you", tone: "text-muted border-line" },
  working: { label: "Working", tone: "text-flesh border-line" },
};

const DOT: Record<string, string> = {
  explore: "bg-muted", run: "bg-ok", gap: "bg-dawn", compile: "bg-dawn", test: "bg-flesh", install: "bg-ok", done: "bg-ok",
  route: "bg-ok", use: "bg-ok", broken: "bg-dawn", blocked: "bg-thread", held: "bg-thread", error: "bg-thread", stopped: "bg-muted", ask: "bg-dawn",
};

type Ask = { pending: Pending | null; onDecide: (d: Decision) => void };

export function Chat({ runs, live, sessions, now, pending, onDecide }: { runs: Run[]; live: Run | null; sessions: { session: number; at: number; capabilities: number }[]; now: number } & Ask) {
  const end = useRef<HTMLDivElement>(null);
  const turns: Turn[] = [
    ...runs.map(r => ({ kind: "run" as const, run: r, live: false })),
    ...(live ? [{ kind: "run" as const, run: live, live: true }] : []),
    ...sessions.map(s => ({ kind: "session" as const, ...s })),
  ].sort((a, b) => (a.kind === "run" ? a.run.at : a.at) - (b.kind === "run" ? b.run.at : b.at));

  const liveCount = live?.events.length ?? 0;
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [turns.length, liveCount, pending]);

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
        : <Exchange key={t.run.id} run={t.run} live={t.live} now={now} ask={t.live ? { pending, onDecide } : undefined} />)}
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

function Exchange({ run, live, now, ask }: { run: Run; live: boolean; now: number; ask?: Ask }) {
  const waiting = live && ask?.pending;
  const outcome = waiting ? { label: "Waiting for you", tone: "text-dawn border-dawn/60" } : OUTCOME[live ? "working" : run.path || "failed"];
  const elapsed = live ? now - run.at : run.ms;
  const proof = [...run.events].reverse().find(e => e.type === "done" || (e.type === "test" && /passed/i.test(e.text || "")));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-night-3 px-4 py-2.5">{run.task}</div>
        <time className="px-1 font-mono text-[11px] text-muted">{clock(run.at)}</time>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <StitchMark />
          <span className="font-semibold">Stitch</span>
          <span className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px] tracking-wider uppercase ${outcome.tone}`}>
            {live && <span className="size-1.5 animate-pulse rounded-full bg-dawn" />}
            {outcome.label}
          </span>
          <span className="flex-1" />
          {run.capability && <span className="truncate font-mono text-xs text-muted">{run.capability}</span>}
        </div>

      <div className="flex max-w-[52rem] flex-col gap-3 rounded-2xl rounded-tl-md border border-line bg-night-2 p-4">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <Meta value={secs(elapsed)} label="" />
          <Meta value={String(run.calls ?? 0)} label={run.calls === 1 ? "model call" : "model calls"} accent={!live && run.calls === 0} />
          <Meta value={money(run.cost)} label="cost" accent={!live && run.cost === 0} />
          <Meta value={((run.tokensIn ?? 0) + (run.tokensOut ?? 0)).toLocaleString()} label="tokens" />
        </div>

        {proof && <p className="text-ok">{proof.text}</p>}
        {run.error && <p className="text-thread">{run.error}</p>}

        {run.data && run.data.length > 0 && <DataTable rows={run.data} name={run.task} />}
        <Filmstrip events={run.events} live={live} />
        <Steps events={run.events} open={live} />
        {waiting && ask?.pending && <Permission pending={ask.pending} onDecide={ask.onDecide} />}
      </div>
      </div>
    </div>
  );
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// The agent's mark: a stitched seam, its whole idea in one glyph.
function StitchMark() {
  return (
    <span className="grid size-6 place-items-center rounded-md bg-dawn text-night" aria-hidden>
      <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <path d="M2 8h12" strokeDasharray="2.2 1.8" />
        <path d="M4 5l1.5 6M8 5l1.5 6M12 5l-1.5 6" />
      </svg>
    </span>
  );
}

function Meta({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className={`font-mono text-lg font-semibold tabular-nums ${accent ? "text-ok" : "text-flesh"}`}>{value}</span>
      {label && <span className="text-sm text-muted">{label}</span>}
    </span>
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

// What the phone showed at each step, newest last. Click a frame to see it large with its step.
function Filmstrip({ events, live }: { events: RunEvent[]; live: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const shots = events.filter(e => e.frame);
  useEffect(() => { if (live) strip.current?.scrollTo({ left: strip.current.scrollWidth, behavior: "smooth" }); }, [shots.length, live]);
  if (!shots.length) return null;
  const current = open === null ? null : shots[open];
  return (
    <>
      <div ref={strip} className="flex gap-2 overflow-x-auto pb-1">
        {shots.map((e, i) => (
          <button key={e.frame} type="button" onClick={() => setOpen(i)} title={e.text}
            className="group relative shrink-0 overflow-hidden rounded-lg border border-line hover:border-dawn">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={ENGINE + e.frame} alt={e.text || "step"} loading="lazy" className="h-36 w-auto object-cover" />
            <span className="absolute inset-x-0 bottom-0 bg-night/85 px-1.5 py-0.5 font-mono text-[10px] text-flesh">{i + 1}</span>
          </button>
        ))}
      </div>
      {current && (
        <div role="dialog" aria-modal="true" onClick={() => setOpen(null)} className="fixed inset-0 z-50 grid place-items-center bg-night/90 p-6">
          <div onClick={ev => ev.stopPropagation()} className="flex max-h-full items-center gap-6">
            <button type="button" aria-label="Previous step" disabled={open === 0} onClick={() => setOpen(o => Math.max((o ?? 0) - 1, 0))}
              className="grid size-12 place-items-center rounded-full border border-line text-2xl disabled:opacity-30">&#8249;</button>
            <figure className="flex max-h-[90vh] flex-col items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={ENGINE + current.frame} alt={current.text || "step"} className="max-h-[80vh] w-auto rounded-2xl border border-line" />
              <figcaption className="max-w-xl text-center">
                <span className="font-mono text-xs tracking-wider text-muted uppercase">Step {(open ?? 0) + 1} of {shots.length} · {current.kind || current.type}</span>
                <p className="text-lg">{current.text}{current.why && <span className="text-muted"> · {current.why}</span>}</p>
              </figcaption>
            </figure>
            <button type="button" aria-label="Next step" disabled={open === shots.length - 1} onClick={() => setOpen(o => Math.min((o ?? 0) + 1, shots.length - 1))}
              className="grid size-12 place-items-center rounded-full border border-line text-2xl disabled:opacity-30">&#8250;</button>
          </div>
        </div>
      )}
    </>
  );
}

// Rows the agent collected, with a CSV download (a real file save; this page runs locally, not in a sandbox).
function DataTable({ rows, name }: { rows: Record<string, string>[]; name: string }) {
  const cols = Object.keys(rows[0]);
  const csv = () => {
    const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const text = [cols.join(","), ...rows.map(r => cols.map(c => cell(String(r[c] ?? ""))).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob(["\ufeff" + text], { type: "text/csv;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${name.replace(/[^\w]+/g, "-").toLowerCase()}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-xs tracking-wider text-muted uppercase">{rows.length} rows</span>
        <button type="button" onClick={csv} className="rounded-lg bg-dawn px-3 py-1.5 text-sm font-semibold text-night">Download CSV</button>
      </div>
      <div className="max-h-96 overflow-auto rounded-xl border border-line">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-night-3">
            <tr>
              <th className="px-3 py-2 text-right font-mono text-xs font-normal text-muted">#</th>
              {cols.map(c => <th key={c} className="px-3 py-2 text-left font-mono text-xs font-normal tracking-wider text-muted uppercase">{c.replace(/_/g, " ")}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-line">
                <td className="px-3 py-1.5 text-right font-mono text-xs text-muted tabular-nums">{i + 1}</td>
                {cols.map(c => <td key={c} className="px-3 py-1.5 tabular-nums">{r[c]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// The agent stops before anything that sends, pays or deletes and asks, like Claude Code before a risky tool.
// Its authority grows only here, by a person's choice, and only for this one capability.
function Permission({ pending, onDecide }: { pending: Pending; onDecide: (d: Decision) => void }) {
  const [sent, setSent] = useState<Decision | null>(null);
  const decide = (d: Decision) => { setSent(d); onDecide(d); };
  const values = Object.entries(pending.params || {});
  return (
    <div role="alertdialog" aria-label="Permission request" className="flex flex-col gap-4 rounded-2xl border-2 border-dawn bg-night p-5">
      <div className="flex items-start gap-3">
        {pending.app && <AppIcon pkg={pending.app} label={pending.title} size={44} />}
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-mono text-xs tracking-wider text-dawn uppercase">Permission needed</span>
          <p className="text-xl font-semibold">Allow Stitch to {pending.title.charAt(0).toLowerCase() + pending.title.slice(1)}?</p>
          <p className="text-muted">This sends, posts, pays or deletes, so it cannot be taken back. Stitch started without this right.</p>
        </div>
      </div>
      {values.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-xl bg-night-2 px-4 py-3">
          {values.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-sm text-muted">{k.replace(/_/g, " ")}</dt>
              <dd className="break-words">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!!sent} onClick={() => decide("once")} className="rounded-xl bg-dawn px-5 py-2.5 text-lg font-semibold text-night disabled:opacity-50">Allow once</button>
        <button type="button" disabled={!!sent} onClick={() => decide("always")} className="rounded-xl border border-dawn px-5 py-2.5 text-lg font-semibold text-dawn hover:bg-dawn/10 disabled:opacity-50">Always allow</button>
        <button type="button" disabled={!!sent} onClick={() => decide("deny")} className="rounded-xl border border-line px-5 py-2.5 text-lg text-muted hover:text-flesh disabled:opacity-50">Deny</button>
      </div>
      <p className="font-mono text-xs text-muted">Always allow applies to {pending.capability} only. You can revoke it from its card.</p>
    </div>
  );
}
