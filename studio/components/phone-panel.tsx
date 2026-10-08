"use client";

import { useRef, type PointerEvent } from "react";
import { api, ENGINE, type Device } from "@/lib/engine";

// Live phone video you can drive with the mouse: click = tap, drag = swipe.
export function PhonePanel({ device, epoch }: { device: Device | null; epoch: number }) {
  const start = useRef<{ x: number; y: number; t: number } | null>(null);
  const w = device?.width || 1080;
  const h = device?.height || 2340;

  const norm = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1), y: Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1) };
  };
  const down = (e: PointerEvent<HTMLDivElement>) => { start.current = { ...norm(e), t: Date.now() }; e.currentTarget.setPointerCapture(e.pointerId); };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    const p = norm(e);
    const moved = Math.hypot((p.x - s.x) * w, (p.y - s.y) * h);
    const body = moved < 25 ? { type: "tap", x: p.x, y: p.y } : { type: "swipe", x1: s.x, y1: s.y, x2: p.x, y2: p.y, ms: Date.now() - s.t };
    api("/api/input", body).catch(() => {});
  };
  const press = (name: string) => api("/api/input", { type: "global", name }).catch(() => {});

  return (
    <div className="flex h-full min-h-0 flex-col items-center gap-4 overflow-y-auto">
      <Status device={device} />
      {/* Sized by the column width, so the phone stays large in a short window; the column scrolls if needed. */}
      <div
        onPointerDown={down}
        onPointerUp={up}
        className="w-full max-w-[460px] shrink-0 cursor-pointer touch-none overflow-hidden rounded-[34px] border-2 border-line bg-black select-none"
        style={{ aspectRatio: `${w} / ${h}` }}
        title="Click to tap, drag to swipe"
      >
        {/* An MJPEG stream; next/image cannot optimize or proxy a never-ending response. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`${ENGINE}/api/stream.mjpg?c=${epoch}`} alt="Live phone screen" draggable={false} className="pointer-events-none block size-full object-cover" />
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <NavButton label="Back" onClick={() => press("back")} d="M15 6l-6 6 6 6" />
        <NavButton label="Home" onClick={() => press("home")} d="M4 11l8-7 8 7v9h-5v-6H9v6H4z" />
        <NavButton label="Recent apps" onClick={() => press("recents")} d="M5 5h14v14H5z" />
        <NavButton label="Notifications" onClick={() => press("notifications")} d="M6 17h12l-2-3v-4a4 4 0 00-8 0v4zM10 20h4" />
      </div>
    </div>
  );
}

function NavButton({ label, onClick, d }: { label: string; onClick: () => void; d: string }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} className="grid size-11 place-items-center rounded-full border border-line bg-night-2 text-flesh hover:border-muted">
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
    </button>
  );
}

function Status({ device }: { device: Device | null }) {
  if (!device) return <div className="h-7" />;
  if (!device.connected) {
    return <div className="flex items-center gap-2 rounded-full border border-thread px-3 py-1 font-mono text-sm text-thread"><Dot ok={false} /> No phone connected over ADB</div>;
  }
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 font-mono text-xs">
      <Pill tone="ok"><Dot ok /> {device.transport}</Pill>
      <Pill>{device.model} · Android {device.android}</Pill>
      <Pill tone={(device.battery ?? 100) < 20 && !device.charging ? "bad" : undefined}>Battery {device.battery}%{device.charging ? ", charging" : ""}</Pill>
      <Pill tone={device.hands ? "ok" : "warn"}>{device.hands ? "Hands on" : "Hands off, using adb"}</Pill>
    </div>
  );
}

function Pill({ children, tone }: { children: React.ReactNode; tone?: "ok" | "bad" | "warn" }) {
  const c = tone === "ok" ? "border-ok/50 text-ok" : tone === "bad" ? "border-thread text-thread" : tone === "warn" ? "border-dawn/60 text-dawn" : "border-line text-muted";
  return <span className={`flex items-center gap-2 rounded-full border px-3 py-1 whitespace-nowrap ${c}`}>{children}</span>;
}

function Dot({ ok }: { ok: boolean }) {
  return <span className={`size-2.5 rounded-full ${ok ? "bg-ok shadow-[0_0_10px] shadow-ok" : "bg-thread"}`} />;
}
