"use client";

import { DEVICES, goTo, usePlace, useDeviceStatus, type Device } from "@/lib/engine";

// Two places to work: your own phone over USB, or the emulators side by side. They are kept apart on purpose, so a
// request meant for every emulator never reaches the personal phone.
export function DeviceBar() {
  const { view, device } = usePlace();
  const phone = DEVICES[0];
  const status = useDeviceStatus(phone);
  const emulators = view === "all";
  const firstEmulator = DEVICES.find(d => d.id !== "phone")?.id;
  return (
    <div role="radiogroup" aria-label="Where to work" className="flex rounded-lg border border-line bg-night-2 p-0.5 text-sm">
      <button type="button" role="radio" aria-checked={!emulators} onClick={() => goTo({ view: "one", device: phone.id })}
        className={`flex items-center gap-2 rounded-md px-3 py-1.5 ${!emulators ? "bg-night-3 text-flesh" : "text-muted hover:text-flesh"}`}>
        <StateDot status={status} /> {phone.label}
      </button>
      <button type="button" role="radio" aria-checked={emulators}
        onClick={() => goTo({ view: "all", device: device.id === "phone" ? firstEmulator : device.id })}
        className={`flex items-center gap-2 rounded-md px-3 py-1.5 ${emulators ? "bg-night-3 text-flesh" : "text-muted hover:text-flesh"}`}>
        <GridIcon /> Emulators
      </button>
    </div>
  );
}

export function StateDot({ status }: { status: Device | null }) {
  const c = !status ? "bg-muted/50" : status.connected ? "bg-ok shadow-[0_0_8px] shadow-ok" : status.offline ? "bg-line" : "bg-thread";
  return <span className={`size-2.5 shrink-0 rounded-full ${c}`} aria-hidden />;
}

const GridIcon = () => (
  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><rect x="3" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" /></svg>
);
