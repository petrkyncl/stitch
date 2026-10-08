import { money, secs, type Run } from "@/lib/engine";

export const PATH_COLOR: Record<string, string> = {
  code: "text-ok",
  installed: "text-ok",
  learned: "text-dawn",
  repaired: "text-dawn",
  held: "text-thread",
  failed: "text-thread",
};

export function Pill({ children, tone }: { children: React.ReactNode; tone: string }) {
  return <span className={`rounded-full border border-current px-2 py-px font-mono text-[10px] tracking-wider whitespace-nowrap uppercase ${PATH_COLOR[tone] || "text-muted"}`}>{children}</span>;
}

export function Runs({ runs }: { runs: Run[] }) {
  const rows = [...runs].reverse();
  return (
    <div className="flex flex-col gap-2">
      <div className="font-mono text-[11px] tracking-[.14em] text-thread uppercase">Runs</div>
      <div className="overflow-x-auto rounded border border-line">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="font-mono text-[10px] tracking-wider text-muted uppercase">
              <th className="px-2.5 py-2 text-right font-normal">S</th>
              <th className="px-2.5 py-2 text-left font-normal">Task</th>
              <th className="px-2.5 py-2 text-left font-normal">Path</th>
              <th className="px-2.5 py-2 text-right font-normal">Time</th>
              <th className="px-2.5 py-2 text-right font-normal">Calls</th>
              <th className="px-2.5 py-2 text-right font-normal">Cost</th>
            </tr>
          </thead>
          <tbody>
            {!rows.length && (
              <tr><td colSpan={6} className="border-t border-line px-2.5 py-2 text-muted">No runs yet. Ask for something on the left.</td></tr>
            )}
            {rows.map(r => (
              <tr key={r.at} className="border-t border-line align-top">
                <td className="px-2.5 py-2 text-right font-mono tabular-nums">{r.session}</td>
                <td className="px-2.5 py-2">
                  {r.task}
                  {r.capability && <div className="font-mono text-xs text-muted">{r.capability}</div>}
                  {r.error && <div className="text-xs text-thread">{r.error}</div>}
                </td>
                <td className="px-2.5 py-2"><Pill tone={r.path}>{r.path}</Pill></td>
                <td className="px-2.5 py-2 text-right font-mono tabular-nums whitespace-nowrap">{secs(r.ms)}</td>
                <td className="px-2.5 py-2 text-right font-mono tabular-nums">{r.calls}</td>
                <td className="px-2.5 py-2 text-right font-mono tabular-nums whitespace-nowrap">{money(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
