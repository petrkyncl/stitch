"use client";

import { useEffect, useRef, useState } from "react";
import { api, engineUrl, money, secs, type Capability, type Decision, type Pending, type Run, type RunEvent } from "@/lib/engine";
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
  route: "bg-ok", use: "bg-ok", broken: "bg-dawn", blocked: "bg-thread", held: "bg-thread", error: "bg-thread", stopped: "bg-muted", ask: "bg-dawn", answer: "bg-dawn",
};

type Ask = { pending: Pending | null; onDecide: (d: Decision) => void };

export function Chat({ runs, live, sessions, now, pending, onDecide, capabilities }: { runs: Run[]; live: Run | null; sessions: { session: number; at: number; capabilities: number }[]; now: number; capabilities: Capability[] } & Ask) {
  const end = useRef<HTMLDivElement>(null);
  const turns: Turn[] = [
    ...runs.map(r => ({ kind: "run" as const, run: r, live: false })),
    ...(live ? [{ kind: "run" as const, run: live, live: true }] : []),
    ...sessions.map(s => ({ kind: "session" as const, ...s })),
  ].sort((a, b) => (a.kind === "run" ? a.run.at : a.at) - (b.kind === "run" ? b.run.at : b.at));

  // Follow new output only while the reader is at the bottom; scrolled up to read, they stay where they are.
  const stick = useRef(true);
  useEffect(() => {
    const box = end.current?.closest(".overflow-y-auto");
    if (!box) return;
    const onScroll = () => { stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 120; };
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => box.removeEventListener("scroll", onScroll);
  }, []);
  const liveCount = live?.events.length ?? 0;
  useEffect(() => { if (stick.current) end.current?.scrollIntoView({ block: "end" }); }, [turns.length, liveCount, pending]);

  if (!turns.length) {
    return (
      <div className="grid flex-1 place-items-center px-6 text-center">
        <div className="flex max-w-md flex-col gap-3">
          <p className="text-3xl font-semibold">Ask for something it can&apos;t do yet</p>
          <p className="text-muted">Stitch starts with only tap, type and read the screen. The first time, it explores the app and writes the capability. Every time after, it runs that code with zero model calls.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 px-1 py-2">
      {turns.map(t => t.kind === "session"
        ? <SessionMark key={`s${t.session}`} session={t.session} capabilities={t.capabilities} />
        : <Exchange key={t.run.id} run={t.run} live={t.live} now={now} capabilities={capabilities} ask={t.live ? { pending, onDecide } : undefined} />)}
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

function Exchange({ run, live, now, ask, capabilities }: { run: Run; live: boolean; now: number; ask?: Ask; capabilities: Capability[] }) {
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
        <div className="flex flex-wrap items-center gap-2">
          <span className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${outcome.tone}`}>
            {live && <span className="size-1.5 animate-pulse rounded-full bg-dawn" />}
            {outcome.label}
          </span>
          <Skill run={run} capabilities={capabilities} />
        </div>

      {/* What you came for first (the result, the answer, the table, a question for you), then the numbers in one
          quiet line, and the steps with their screenshots folded away. */}
      <div className="flex max-w-[46rem] flex-col gap-3 rounded-2xl rounded-tl-md border border-line bg-night-2 px-4 py-3">
        {live && !waiting && run.events.length > 0 && (
          <p className="flex items-center gap-2 text-muted"><span className="size-1.5 shrink-0 animate-pulse rounded-full bg-dawn" />{run.events.at(-1)?.text}</p>
        )}
        {waiting && ask?.pending && <Permission pending={ask.pending} onDecide={ask.onDecide} />}
        {!live && proof && <p className="text-ok">{proof.text}</p>}
        {(run.reply || (live && run.events.findLast(e => e.type === "answer")?.text)) && (
          <Answer text={run.reply || run.events.findLast(e => e.type === "answer")?.text || ""} name={run.task} />
        )}
        {run.error && <p className="text-thread">{run.error}</p>}
        {run.data && run.data.length > 0 && <DataTable rows={run.data} name={run.task} />}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
          <span className="tabular-nums text-flesh">{secs(elapsed)}</span>
          <span><span className={`tabular-nums ${!live && run.calls === 0 ? "text-ok" : "text-flesh"}`}>{run.calls ?? 0}</span> {run.calls === 1 ? "model call" : "model calls"}</span>
          <span className={`tabular-nums ${!live && run.cost === 0 ? "text-ok" : "text-flesh"}`}>{money(run.cost)}</span>
          <span><span className="tabular-nums text-flesh">{((run.tokensIn ?? 0) + (run.tokensOut ?? 0)).toLocaleString()}</span> tokens</span>
          <span className="flex-1" />
          {!live && !run.ok && <Report id={run.id} />}
        </div>

        <Details events={run.events} live={live} />
      </div>
      </div>
    </div>
  );
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// Which learned capability did the work, in words: its app icon, its title and version, the code name on hover.
function Skill({ run, capabilities }: { run: Run; capabilities: Capability[] }) {
  if (!run.capability) return null;
  const parts = run.capability.split(" + ").map(part => {
    const [name, v] = part.split(" ");
    const cap = capabilities.find(c => c.name === name);
    const title = cap?.title || name.split(".").pop()!.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
    return { name, title, app: cap?.app, version: (v || (cap ? `v${cap.version}` : "")).replace("v", "version ") };
  });
  return (
    <span title={`Capability ${run.capability}`} className="flex flex-wrap items-center gap-1.5 text-sm text-muted">
      <span aria-hidden>using</span>
      {parts.map((p, i) => (
        <span key={p.name + i} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>then</span>}
          {p.app && <AppIcon pkg={p.app} label={p.title} size={18} />}
          <span className="text-flesh">{p.title}</span>
          {p.version && <span>{p.version}</span>}
        </span>
      ))}
    </span>
  );
}

// Every step of the run, inside the folded details.
function Steps({ events }: { events: RunEvent[] }) {
  const visible = events;
  if (!events.length) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <ol className="flex flex-col gap-1.5">
        {visible.map((e, i) => (
          <li key={i} className="grid grid-cols-[14px_84px_minmax(0,1fr)] items-baseline gap-2 text-[15px]">
            <span className={`size-2 translate-y-[-1px] rounded-full ${DOT[e.kind || e.type] || "bg-muted"}`} />
            <span className="text-sm text-muted capitalize">{e.kind || e.type}</span>
            <span className="break-words">{e.text}{e.why && <span className="block text-sm text-muted">{e.why}</span>}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// What the phone showed at each step, newest last. Click a frame to see it large with its step.
function Filmstrip({ events, live }: { events: RunEvent[]; live: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const shots = events.filter(e => e.frame);
  useEffect(() => { if (live) strip.current?.scrollTo({ left: strip.current.scrollWidth, behavior: "smooth" }); }, [shots.length, live]);
  // Left and right arrow keys step through, Esc closes.
  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
      if (e.key === "ArrowLeft") setOpen(o => Math.max((o ?? 0) - 1, 0));
      if (e.key === "ArrowRight") setOpen(o => Math.min((o ?? 0) + 1, shots.length - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, shots.length]);
  if (!shots.length) return null;
  const current = open === null ? null : shots[open];
  return (
    <>
      <div ref={strip} className="flex gap-2 overflow-x-auto pb-1">
        {shots.map((e, i) => (
          <button key={e.frame} type="button" onClick={() => setOpen(i)} title={e.text}
            className="group relative shrink-0 overflow-hidden rounded-lg border border-line hover:border-dawn">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={engineUrl() + e.frame} alt={e.text || "step"} loading="lazy" className="h-36 w-auto object-cover" />
            <span className="absolute inset-x-0 bottom-0 bg-night/85 px-1.5 py-0.5 font-mono text-[10px] text-flesh">{i + 1}</span>
          </button>
        ))}
      </div>
      {current && (
        <div role="dialog" aria-modal="true" onClick={() => setOpen(null)} className="fixed inset-0 z-50 grid place-items-center bg-night/90 p-6">
          {/* Arrows sit at fixed places on the screen, centered top to bottom, so they never move between steps. */}
          <Arrow side="left" label="Previous step" disabled={open === 0} onClick={() => setOpen(o => Math.max((o ?? 0) - 1, 0))} />
          <figure onClick={ev => ev.stopPropagation()} className="flex flex-col items-center gap-3">
            <div className="h-[78vh] overflow-hidden rounded-2xl border border-line bg-black" style={{ aspectRatio: "1080 / 2340" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={engineUrl() + current.frame} alt={current.text || "step"} className="size-full object-contain" />
            </div>
            <figcaption className="h-20 w-[36rem] max-w-[80vw] text-center">
              <span className="text-sm text-muted">Step {(open ?? 0) + 1} of {shots.length}</span>
              <p className="text-lg">{current.text}{current.why && <span className="block text-base text-muted">{current.why}</span>}</p>
            </figcaption>
          </figure>
          <Arrow side="right" label="Next step" disabled={open === shots.length - 1} onClick={() => setOpen(o => Math.min((o ?? 0) + 1, shots.length - 1))} />
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
        <span className="text-sm text-muted">{rows.length} rows</span>
        <button type="button" onClick={csv} className="rounded-lg bg-dawn px-3 py-1.5 text-sm font-semibold text-night">Download CSV</button>
      </div>
      <div className="max-h-96 overflow-auto rounded-xl border border-line">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-night-3">
            <tr>
              <th className="px-3 py-2 text-right font-mono text-xs font-normal text-muted">#</th>
              {cols.map(c => <th key={c} className="px-3 py-2 text-left text-xs font-medium text-muted capitalize">{c.replace(/_/g, " ")}</th>)}
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

// The agent runs up to the step that sends, pays or deletes and asks there, like Claude Code before a risky tool.
// Its authority grows only here, by a person's choice, and only for this one capability.
export function Permission({ pending, onDecide }: { pending: Pending; onDecide: (d: Decision) => void }) {
  const [sent, setSent] = useState<Decision | null>(null);
  const decide = (d: Decision) => { setSent(d); onDecide(d); };
  const values = Object.entries(pending.params || {});
  const action = pending.title.charAt(0).toLowerCase() + pending.title.slice(1);
  return (
    <div role="alertdialog" aria-label="Permission request" className="flex flex-col gap-3 rounded-xl border border-dawn/40 bg-night px-4 py-3">
      <div className="flex items-center gap-2">
        {pending.app && <AppIcon pkg={pending.app} label={pending.title} size={20} />}
        <p>Allow Stitch to {action}{pending.step ? <span className="text-muted"> (tap &quot;{pending.step}&quot;)</span> : null}?</p>
      </div>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map(([k, v]) => (
            <span key={k} className="rounded-md bg-night-3 px-2 py-0.5 text-sm"><span className="text-muted">{k.replace(/_/g, " ")}</span> {v}</span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" disabled={!!sent} onClick={() => decide("once")} className="rounded-lg bg-dawn px-3 py-1 text-sm font-medium text-night disabled:opacity-50">Allow once</button>
        <button type="button" disabled={!!sent} onClick={() => decide("always")} title={`Applies to ${pending.capability} only; revoke it from its card`} className="rounded-lg px-3 py-1 text-sm text-flesh hover:bg-night-3 disabled:opacity-50">Always allow</button>
        <button type="button" disabled={!!sent} onClick={() => decide("deny")} className="rounded-lg px-3 py-1 text-sm text-muted hover:bg-night-3 hover:text-flesh disabled:opacity-50">Deny</button>
        <span className="ml-auto text-xs text-muted">cannot be undone</span>
      </div>
    </div>
  );
}

// One click puts everything needed to find out what went wrong on the clipboard (steps with times, the model's raw
// decisions, the capability, the screen), and the engine keeps the same text in runs/reports/.
function Report({ id }: { id: string }) {
  const [state, setState] = useState<"idle" | "busy" | "copied" | "failed">("idle");
  const copy = async () => {
    setState("busy");
    try {
      const { text } = await api<{ text: string }>(`/api/report?run=${id}`);
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch { setState("failed"); }
  };
  return (
    <div className="flex items-center gap-3 text-sm">
      <button type="button" onClick={copy} disabled={state === "busy"} className="text-thread underline-offset-4 hover:underline disabled:opacity-50">
        {state === "busy" ? "Collecting..." : "Report"}
      </button>
      {state === "copied" && <span className="text-muted">Copied. Also saved as runs/reports/{id}.md</span>}
      {state === "failed" && <span className="text-thread">Could not collect the report</span>}
    </div>
  );
}

function Arrow({ side, label, disabled, onClick }: { side: "left" | "right"; label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} disabled={disabled} onClick={ev => { ev.stopPropagation(); onClick(); }}
      className={`fixed top-1/2 grid size-12 -translate-y-1/2 place-items-center rounded-full border border-line bg-night-2 text-flesh hover:border-muted disabled:opacity-30 ${side === "left" ? "left-8" : "right-8"}`}>
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={side === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
      </svg>
    </button>
  );
}

// What the app answered, with a quiet copy and a download as a text file.
function Answer({ text, name }: { text: string; name: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(text).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${name.replace(/[^\w]+/g, "-").toLowerCase().slice(0, 60)}.txt` });
    a.click();
    URL.revokeObjectURL(url);
  };
  const icon = "grid size-7 place-items-center rounded-md text-muted hover:bg-night-3 hover:text-flesh";
  return (
    <figure className="flex flex-col gap-1.5 rounded-xl border-l-2 border-dawn bg-night px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <figcaption className="text-sm text-muted">The app answered</figcaption>
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={copy} title={copied ? "Copied" : "Copy"} aria-label="Copy the answer" className={icon}>
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {copied ? <path d="M5 12l5 5 9-10" /> : <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 012-2h10" /></>}
            </svg>
          </button>
          <button type="button" onClick={download} title="Download as a text file" aria-label="Download the answer" className={icon}>
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
            </svg>
          </button>
        </div>
      </div>
      <p className="whitespace-pre-wrap">{text}</p>
    </figure>
  );
}

// Steps and screenshots, folded by default: most of the time you want the result, not the replay.
function Details({ events, live }: { events: RunEvent[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  if (!events.length) return null;
  const shots = events.filter(e => e.frame).length;
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-2">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="flex items-center gap-1.5 self-start text-sm text-muted hover:text-flesh">
        <svg viewBox="0 0 24 24" className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 6l6 6-6 6" /></svg>
        {events.length} steps{shots ? ` and ${shots} screenshots` : ""}
      </button>
      {open && (
        <>
          <Filmstrip events={events} live={live} />
          <Steps events={events} />
        </>
      )}
    </div>
  );
}
