import type { Capability, EngineState } from "@/lib/engine";
import { Pill } from "./runs";

type Props = {
  capabilities: Capability[];
  granted?: EngineState["granted"];
  onApprove: (name: string) => void;
  onBreak: (name: string) => void;
};

export function Registry({ capabilities, granted, onApprove, onBreak }: Props) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3 font-mono text-[11px] tracking-[.14em] uppercase">
        <span className="text-thread">Registry</span>
        {granted && <span className="tracking-normal text-muted normal-case">granted: {granted.permissions.join(", ")}, effect {granted.effects.join("/")}</span>}
      </div>
      {!capabilities.length && <p className="text-sm text-muted">Empty. Stitch starts with only tap, type and read the screen.</p>}
      {capabilities.map(c => (
        <div key={c.name} className="flex flex-col gap-1.5 rounded border border-line bg-night-2 px-3.5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono font-medium">{c.name}({c.params.join(", ")}) v{c.version}</span>
            <Pill tone={c.status}>{c.status === "held" ? "held for approval" : c.status}</Pill>
          </div>
          <p className="text-sm">{c.description}</p>
          <div className="flex flex-wrap gap-x-3.5 gap-y-1 font-mono text-xs text-muted">
            <span>{c.steps} steps</span>
            <span>effect {c.effect}</span>
            <span>tests {c.tests?.passed ?? 0}/{c.tests?.total ?? 0}</span>
            <span>runs {c.runs}</span>
          </div>
          {c.status === "held" && c.reason && <p className="font-mono text-xs text-thread">{c.reason}</p>}
          <div className="flex flex-wrap gap-2">
            {c.status === "held" && (
              <button type="button" onClick={() => onApprove(c.name)} className="rounded bg-dawn px-2.5 py-1 text-xs font-semibold text-night">Approve</button>
            )}
            {c.status === "installed" && (
              <button type="button" onClick={() => onBreak(c.name)} className="rounded border border-line px-2.5 py-1 text-xs text-muted hover:text-flesh">Simulate app update</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
