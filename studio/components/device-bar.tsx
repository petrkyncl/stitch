"use client";

import { useEffect, useRef, useState } from "react";
import { DEVICES, goTo, usePlace, useDeviceStatus, type DeviceDef, type Device } from "@/lib/engine";

// Which device the studio drives, and whether to see one of them or all side by side.
export function DeviceBar() {
  return (
    <div className="flex items-center gap-2">
      <DevicePicker />
      <ViewSwitch />
    </div>
  );
}

function DevicePicker() {
  const { device, view } = usePlace();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const status = useDeviceStatus(device);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, []);

  const pick = (id: string) => { goTo({ device: id, view: "one" }); setOpen(false); };

  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}
        className="flex items-center gap-2.5 rounded-lg border border-line bg-night-2 px-3 py-2 font-sans text-base hover:border-muted">
        <StateDot status={status} />
        {view === "all" ? "All devices" : device.label}
        <span aria-hidden className="text-xs text-muted">▾</span>
      </button>
      {open && (
        <div role="listbox" aria-label="Device" className="absolute top-full right-0 z-40 mt-2 flex w-80 flex-col overflow-hidden rounded-xl border border-line bg-night-2 py-1 font-sans shadow-2xl">
          <p className="px-3 pt-2 pb-1 font-mono text-[10px] tracking-wider text-muted uppercase">Devices</p>
          {DEVICES.map(d => <Option key={d.id} d={d} active={view === "one" && d.id === device.id} onPick={() => pick(d.id)} />)}
          <div className="my-1 border-t border-line" />
          <button type="button" onClick={() => { goTo({ view: "all" }); setOpen(false); }}
            className={`flex items-center gap-3 px-3 py-2.5 text-left hover:bg-night-3 ${view === "all" ? "bg-night-3" : ""}`}>
            <GridIcon /> See all devices side by side
          </button>
        </div>
      )}
    </div>
  );
}

function Option({ d, active, onPick }: { d: DeviceDef; active: boolean; onPick: () => void }) {
  const status = useDeviceStatus(d);
  return (
    <button type="button" role="option" aria-selected={active} onClick={onPick}
      className={`flex items-center gap-3 px-3 py-2 text-left hover:bg-night-3 ${active ? "bg-night-3" : ""}`}>
      <StateDot status={status} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{d.label}</span>
        <span className="truncate font-mono text-[11px] text-muted">{describe(status)}</span>
      </span>
      {active && <span aria-hidden className="text-dawn">✓</span>}
    </button>
  );
}

const describe = (s: Device | null) =>
  !s ? "checking" : s.offline ? "not running" : !s.connected ? "engine up, no device" : `${s.model} · Android ${s.android}`;

export function StateDot({ status }: { status: Device | null }) {
  const c = !status ? "bg-muted/50" : status.connected ? "bg-ok shadow-[0_0_8px] shadow-ok" : status.offline ? "bg-line" : "bg-thread";
  return <span className={`size-2.5 shrink-0 rounded-full ${c}`} aria-hidden />;
}

function ViewSwitch() {
  const { view } = usePlace();
  const item = (v: "one" | "all", label: string, icon: React.ReactNode) => (
    <button type="button" onClick={() => goTo({ view: v })} aria-pressed={view === v} title={label} aria-label={label}
      className={`grid size-9 place-items-center rounded-md ${view === v ? "bg-night-3 text-flesh" : "text-muted hover:text-flesh"}`}>
      {icon}
    </button>
  );
  return (
    <div className="flex rounded-lg border border-line bg-night-2 p-0.5">
      {item("one", "One device", <PhoneIcon />)}
      {item("all", "All devices", <GridIcon />)}
    </div>
  );
}

const PhoneIcon = () => (
  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" strokeLinecap="round" /></svg>
);
const GridIcon = () => (
  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><rect x="2.5" y="4" width="5" height="16" rx="1.5" /><rect x="9.5" y="4" width="5" height="16" rx="1.5" /><rect x="16.5" y="4" width="5" height="16" rx="1.5" /></svg>
);
