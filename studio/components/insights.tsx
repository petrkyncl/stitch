import { money, secs, type Capability, type EngineState, type Run } from "@/lib/engine";

type Props = {
  runs: Run[];
  capabilities: Capability[];
  granted?: EngineState["granted"];
  onApprove: (name: string) => void;
  onBreak: (name: string) => void;
};

const capName = (r: Run) => r.capability?.replace(/ v\d+$/, "");

export function Insights({ runs, capabilities, granted, onApprove, onBreak }: Props) {
  return (
    <div className="flex flex-col gap-8">
      <LearnVsReuse runs={runs} />
      <Totals runs={runs} />
      <Registry capabilities={capabilities} granted={granted} onApprove={onApprove} onBreak={onBreak} />
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

function Registry({ capabilities, granted, onApprove, onBreak }: Omit<Props, "runs">) {
  return (
    <Section title="Capabilities" note={granted ? `granted: ${granted.permissions.join(", ")} · effect ${granted.effects.join("/")}` : undefined}>
      {!capabilities.length && <p className="text-muted">None yet. Stitch starts with only tap, type and read the screen.</p>}
      {capabilities.map(c => (
        <div key={c.name} className="flex flex-col gap-2 rounded-xl border border-line bg-night-2 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-base">{c.name}({c.params.join(", ")}) <span className="text-muted">v{c.version}</span></span>
            <span className={`rounded-full border px-2.5 py-0.5 font-mono text-xs tracking-wider uppercase ${c.status === "held" ? "border-thread/60 text-thread" : "border-ok/60 text-ok"}`}>
              {c.status === "held" ? "held for approval" : "installed"}
            </span>
          </div>
          <p className="text-[15px] text-flesh/90">{c.description}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted">
            <span>{c.steps} steps</span><span>effect {c.effect}</span><span>tests {c.tests?.passed ?? 0}/{c.tests?.total ?? 0}</span><span>runs {c.runs}</span>
          </div>
          {c.status === "held" && c.reason && <p className="font-mono text-xs text-thread">{c.reason}</p>}
          <div className="flex gap-2">
            {c.status === "held"
              ? <button type="button" onClick={() => onApprove(c.name)} className="rounded-lg bg-dawn px-3 py-1.5 text-sm font-semibold text-night">Approve</button>
              : <button type="button" onClick={() => onBreak(c.name)} className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:text-flesh">Simulate app update</button>}
          </div>
        </div>
      ))}
    </Section>
  );
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
