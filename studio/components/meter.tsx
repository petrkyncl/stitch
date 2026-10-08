import { money, secs, type MeterSnapshot } from "@/lib/engine";

export function Meter({ meter, elapsed, busy }: { meter: MeterSnapshot; elapsed: number; busy: boolean }) {
  const free = meter.calls === 0 && elapsed > 0 && !busy;
  const value = `font-display text-5xl leading-none font-black tabular-nums xl:text-6xl ${free ? "text-ok" : "text-flesh"}`;
  return (
    <div className="flex flex-col gap-2 rounded border border-line bg-night-2 px-4.5 py-4">
      <div className="font-mono text-[11px] tracking-[.14em] text-thread uppercase">This task</div>
      <div className="grid grid-cols-3 gap-3">
        <Fig value={String(meter.calls)} unit="model calls" className={value} />
        <Fig value={money(meter.cost)} unit="cost" className={value} />
        <Fig value={secs(elapsed)} unit="time" className={value} />
      </div>
      <div className="font-mono text-xs text-muted">
        {meter.tokensIn.toLocaleString()} tokens in, {meter.tokensOut.toLocaleString()} out
      </div>
    </div>
  );
}

function Fig({ value, unit, className }: { value: string; unit: string; className: string }) {
  return (
    <div className="flex flex-col">
      <span className={className}>{value}</span>
      <span className="font-mono text-[11px] text-muted">{unit}</span>
    </div>
  );
}
