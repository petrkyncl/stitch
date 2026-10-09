"use client";

import { useEffect, useState } from "react";
import { api, money, secs, type App, type Capability, type EngineState, type Run } from "@/lib/engine";
import { AppIcon } from "./app-picker";

type Props = {
  runs: Run[];
  capabilities: Capability[];
  granted?: EngineState["granted"];
  onApprove: (name: string) => void;
  onRevoke: (name: string) => void;
  onBreak: (name: string) => void;
};

const capName = (r: Run) => r.capability?.replace(/ v\d+$/, "");

export function Insights({ runs, capabilities, granted, onApprove, onRevoke, onBreak }: Props) {
  return (
    <div className="flex flex-col gap-8">
      <LearnVsReuse runs={runs} />
      <Totals runs={runs} />
      <Registry capabilities={capabilities} granted={granted} onApprove={onApprove} onRevoke={onRevoke} onBreak={onBreak} />
    </div>
  );
}

// The point of the project in one panel: what learning cost versus what reuse costs.
function LearnVsReuse({ runs }: { runs: Run[] }) {
  const learned = [...runs].reverse().find(r => (r.path === "learned" || r.path === "repaired") && r.ok);
  const reuse = learned ? runs.filter(r => r.path === "code" && r.ok && capName(r) === capName(learned)) : [];
  if (!learned) {
    return (
      <Section title="Learning vs reuse">
        <p className="text-muted">After Stitch learns its first capability, this compares that run with every run that reuses it.</p>
      </Section>
    );
  }
  const avg = (k: "ms" | "calls" | "cost") => (reuse.length ? reuse.reduce((s, r) => s + r[k], 0) / reuse.length : 0);
  const reuseMs = avg("ms");
  const max = Math.max(learned.ms, reuseMs, 1);
  const faster = reuse.length && reuseMs > 0 ? learned.ms / reuseMs : 0;

  return (
    <Section title="Learning vs reuse" note={capName(learned)}>
      {reuse.length > 0 && (
        <div className="flex flex-wrap gap-x-8 gap-y-2">
          <Big value={`${faster.toFixed(1)}×`} label="faster" />
          <Big value={String(Math.round(avg("calls")))} label="model calls" />
          <Big value={money(avg("cost"))} label="per run" />
        </div>
      )}
      <div className="flex flex-col gap-3">
        <Bar label="First run, learning" ms={learned.ms} max={max} meta={`${learned.calls} calls · ${money(learned.cost)}`} tone="bg-dawn" />
        {reuse.length > 0
          ? <Bar label={`Reuse, average of ${reuse.length}`} ms={reuseMs} max={max} meta={`${Math.round(avg("calls"))} calls · ${money(avg("cost"))}`} tone="bg-ok" />
          : <p className="text-sm text-muted">Start a new session and ask again with a different input to see reuse.</p>}
      </div>
    </Section>
  );
}

function Bar({ label, ms, max, meta, tone }: { label: string; ms: number; max: number; meta: string; tone: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between gap-3 text-sm"><span>{label}</span><span className="font-mono text-muted">{meta}</span></div>
      <div className="flex items-center gap-3">
        <div className="h-3 flex-1 overflow-hidden rounded-full bg-night-3">
          <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max((ms / max) * 100, 2)}%` }} />
        </div>
        <span className="w-16 text-right font-mono text-sm tabular-nums">{secs(ms)}</span>
      </div>
    </div>
  );
}

function Totals({ runs }: { runs: Run[] }) {
  const calls = runs.reduce((s, r) => s + r.calls, 0);
  const cost = runs.reduce((s, r) => s + r.cost, 0);
  const free = runs.filter(r => r.calls === 0 && r.ok).length;
  return (
    <Section title="All runs">
      <div className="grid grid-cols-3 gap-4">
        <Small value={String(runs.length)} label="tasks" />
        <Small value={String(free)} label="with zero model calls" />
        <Small value={money(cost)} label={`total, ${calls} calls`} />
      </div>
    </Section>
  );
}

function Registry({ capabilities, granted, onApprove, onRevoke, onBreak }: Omit<Props, "runs">) {
  const [apps, setApps] = useState<App[]>([]);
  useEffect(() => { api<App[]>("/api/apps").then(setApps).catch(() => {}); }, [capabilities.length]);
  const appLabel = (pkg?: string) => apps.find(a => a.package === pkg)?.label || pkg?.split(".").pop() || "app";

  return (
    <Section title="What it has learned" note={granted ? `started with: ${granted.permissions.join(", ").replace(/_/g, " ")}` : undefined}>
      {!capabilities.length && <p className="text-muted">Nothing yet. Stitch starts able to read the screen, tap and type, nothing more.</p>}
      {capabilities.map(c => {
        const needsApproval = c.status === "held";
        const asks = c.effect === "external";
        const repaired = (c.history?.length ?? 1) > 1;
        return (
          <article key={c.name} className="flex flex-col gap-3 rounded-2xl border border-line bg-night-2 p-4">
            <div className="flex items-start gap-3">
              {c.app ? <AppIcon pkg={c.app} label={appLabel(c.app)} size={44} /> : <span className="size-11 rounded-xl bg-night-3" />}
              <div className="flex min-w-0 flex-1 flex-col">
                <h3 className="text-lg leading-tight font-semibold">{c.title}</h3>
                <span className="text-sm text-muted">in {appLabel(c.app)}</span>
              </div>
              <Status needsApproval={needsApproval} approved={c.approved} />
            </div>

            <p className="text-[15px] text-flesh/90">{c.description}</p>

            {c.paramInfo.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted">You tell it</span>
                {c.paramInfo.map(p => (
                  <span key={p.name} title={p.description} className="rounded-full border border-line px-2.5 py-0.5 text-sm">
                    {p.name.replace(/_/g, " ")}{p.example ? <span className="text-muted"> e.g. {p.example}</span> : null}
                  </span>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
              <span>Used {c.runs}×</span>
              <span>{c.tests?.total ? (c.tests.passed === c.tests.total ? "Test passed" : "Test failed") : "Not tested, it would change something"}</span>
              <span>{c.steps} steps</span>
              <span>{repaired ? `Version ${c.version}, repaired after an app change` : `Version ${c.version}`}</span>
            </div>

            {asks && (
              // The one right Stitch never grants itself: set it ahead of time, take it back any time.
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-night px-3 py-2">
                <span className="text-sm text-muted">Before it sends, pays or deletes</span>
                <div role="radiogroup" aria-label={`Permission for ${c.title}`} className="flex rounded-lg border border-line p-0.5 text-sm">
                  <button type="button" role="radio" aria-checked={!c.approved} onClick={() => c.approved && onRevoke(c.name)}
                    className={`rounded-md px-3 py-1 ${!c.approved ? "bg-night-3 text-flesh" : "text-muted hover:text-flesh"}`}>Ask every time</button>
                  <button type="button" role="radio" aria-checked={c.approved} onClick={() => !c.approved && onApprove(c.name)}
                    className={`rounded-md px-3 py-1 ${c.approved ? "bg-dawn font-medium text-night" : "text-muted hover:text-flesh"}`}>Always allow</button>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
              <code className="font-mono text-xs text-muted">{c.name}({c.params.join(", ")})</code>
              <button type="button" onClick={() => onBreak(c.name)} className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:text-flesh" title="Pretend the app changed, to watch Stitch repair itself">Simulate app update</button>
            </div>
          </article>
        );
      })}
    </Section>
  );
}

function Status({ needsApproval, approved }: { needsApproval: boolean; approved: boolean }) {
  const [label, tone] = needsApproval ? ["Asks first", "border-thread/60 text-thread"] : approved ? ["Always allowed", "border-dawn/60 text-dawn"] : ["Ready", "border-ok/60 text-ok"];
  return <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs whitespace-nowrap ${tone}`}>{label}</span>;
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-mono text-xs tracking-[.16em] text-thread uppercase">{title}</h2>
        {note && <span className="font-mono text-xs text-muted">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Big({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col">
      <span className="font-display text-6xl leading-none font-black text-ok tabular-nums">{value}</span>
      <span className="mt-1 font-mono text-xs text-muted">{label}</span>
    </div>
  );
}

function Small({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col">
      <span className="font-display text-3xl leading-none font-black tabular-nums">{value}</span>
      <span className="mt-1 font-mono text-xs text-muted">{label}</span>
    </div>
  );
}
