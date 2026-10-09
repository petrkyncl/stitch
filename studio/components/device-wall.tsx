"use client";

import { DEVICES, videoUrl, useDeviceStatus, type DeviceDef } from "@/lib/engine";
import { LiveScreen } from "./live-screen";
import { StateDot } from "./device-bar";

// Every device live, side by side in one row sized to fit the window. Click one to work with it.
const GAP_REM = 1.5;
const TILE_HEIGHT = `min(calc(100dvh - 13rem), calc((100vw - 4rem - ${(DEVICES.length - 1) * GAP_REM}rem) / ${DEVICES.length} / 0.46))`;

export function DeviceWall({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <main className="flex min-h-0 flex-1 items-start justify-center-safe overflow-auto px-8 py-6" style={{ gap: `${GAP_REM}rem` }}>
      {DEVICES.map(d => <Tile key={d.id} d={d} onOpen={() => onOpen(d.id)} />)}
    </main>
  );
}

function Tile({ d, onOpen }: { d: DeviceDef; onOpen: () => void }) {
  const status = useDeviceStatus(d);
  const w = status?.width || 1080;
  const h = status?.height || 2340;
  return (
    <button type="button" onClick={onOpen} title={`Work with ${d.label}`} className="group flex shrink-0 flex-col items-center gap-3">
      {/* w-0 min-w-full: the label takes the screen's width and never widens the tile. */}
      <span className="flex w-0 min-w-full items-center justify-center gap-2 font-mono text-sm">
        <StateDot status={status} />
        <span className="shrink-0 text-flesh">{d.label}</span>
        {status?.model && <span className="truncate text-muted">{status.model}</span>}
      </span>
      <span className="relative block overflow-hidden rounded-[18px] border-2 border-line bg-black transition-colors group-hover:border-dawn/70"
        style={{ height: TILE_HEIGHT, aspectRatio: `${w} / ${h}` }}>
        <LiveScreen src={status && !status.offline && status.connected ? `${videoUrl(d)}?s=${status.started ?? 0}` : null} label={d.label}
          offline={!!status && (status.offline || !status.connected)} hint={d.id === "phone" ? "npm start" : "scripts/emulators.sh up"} />
      </span>
    </button>
  );
}
