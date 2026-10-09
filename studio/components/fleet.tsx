"use client";

import { useEffect, useState } from "react";
import { DEVICES, engineUrl, goTo, usePlace, useDeviceStatus, videoUrl, money, secs, type DeviceDef, type EngineState } from "@/lib/engine";
import { LiveScreen } from "./live-screen";
import { StateDot } from "./device-bar";

// The emulators live in a row next to the chat (the personal phone is never part of it). Each tile says what its
// emulator is doing; clicking one makes it the one the chat talks to.
export const EMULATORS = DEVICES.filter(d => d.id !== "phone");

export function Fleet() {
  const { device } = usePlace();
  const cols = EMULATORS.length > 4 ? Math.ceil(EMULATORS.length / 2) : EMULATORS.length; // two rows: 6 sit as 3 and 3
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center justify-end"><BoxesForAll /></div>
      <div className="grid min-h-0 flex-1 auto-rows-fr gap-4 overflow-y-auto" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {EMULATORS.map(d => <Tile key={d.id} d={d} active={d.id === device.id} />)}
      </div>
    </div>
  );
}

// One switch for the element boxes on every emulator. Each engine remembers it, so restarts keep the choice.
function BoxesForAll() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    fetch(engineUrl(EMULATORS[0]) + "/api/state").then(r => r.json()).then((s: EngineState) => setOn(s.boxes ?? true)).catch(() => {});
  }, []);
  const flip = () => {
    const next = !(on ?? true);
    setOn(next);
    EMULATORS.forEach(d => fetch(engineUrl(d) + "/api/overlay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: next }) }).catch(() => {}));
  };
  const value = on ?? true;
  return (
    <button type="button" role="switch" aria-checked={value} onClick={flip} title="Boxes around every element the agent can see, on all emulators"
      className={`flex h-9 items-center gap-2 rounded-full border px-3.5 text-sm ${value ? "border-dawn/60 text-dawn" : "border-line text-muted hover:text-flesh"}`}>
      <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="5" rx="1.5" /><rect x="13" y="11" width="8" height="10" rx="1.5" /><rect x="3" y="14" width="8" height="7" rx="1.5" />
      </svg>
      Boxes
    </button>
  );
}

function Tile({ d, active }: { d: DeviceDef; active: boolean }) {
  const status = useDeviceStatus(d);
  const activity = useActivity(d, !!status?.connected);
  const w = status?.width || 1080;
  const h = status?.height || 2340;
  return (
    <button type="button" onClick={() => goTo({ device: d.id })} aria-pressed={active} title={`Chat with ${d.label}`}
      className={`flex min-h-0 flex-col gap-2 rounded-2xl border p-3 text-left transition-colors ${active ? "border-dawn/70 bg-night-2" : "border-line hover:border-muted"}`}>
      <span className="flex items-center gap-2 text-sm">
        <StateDot status={status} />
        <span className="font-medium">{d.label}</span>
        {status?.model && <span className="truncate text-muted">{status.model}</span>}
      </span>
      <span className="flex min-h-0 flex-1 justify-center">
        <span className="relative block h-full overflow-hidden rounded-xl border border-line bg-black" style={{ aspectRatio: `${w} / ${h}` }}>
          <LiveScreen src={status && !status.offline && status.connected ? `${videoUrl(d)}?s=${status.started ?? 0}` : null} label={d.label}
            offline={!!status && (status.offline || !status.connected)} hint={d.id === "phone" ? "npm start" : "scripts/emulators.sh up"} />
        </span>
      </span>
      <Activity a={activity} />
    </button>
  );
}

type Act = { busy: boolean; step?: string; task?: string; ok?: boolean; path?: string; ms?: number; calls?: number; cost?: number } | null;

// What a device is doing, from its engine: the running step, or how its last request ended.
function useActivity(d: DeviceDef, enabled: boolean): Act {
  const [a, setA] = useState<Act>(null);
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    const poll = () => fetch(engineUrl(d) + "/api/state", { signal: AbortSignal.timeout(3000) })
      .then(r => r.json())
      .then((s: EngineState) => {
        if (stop) return;
        const last = s.runs.at(-1);
        setA(s.current
          ? { busy: true, task: s.current.task, step: s.pending ? "Waiting for your permission" : s.current.events.at(-1)?.text }
          : last ? { busy: false, task: last.task, ok: last.ok, path: last.path, ms: last.ms, calls: last.calls, cost: last.cost } : { busy: false });
      })
      .catch(() => {});
    poll();
    const t = setInterval(poll, 1500);
    return () => { stop = true; clearInterval(t); };
  }, [d, enabled]);
  return a;
}

function Activity({ a }: { a: Act }) {
  if (!a?.task) return <span className="h-10 text-sm text-muted">Idle</span>;
  return (
    <span className="flex h-10 flex-col text-sm leading-snug">
      <span className="truncate">{a.task}</span>
      {a.busy
        ? <span className="flex items-center gap-1.5 truncate text-muted"><span className="size-1.5 shrink-0 animate-pulse rounded-full bg-dawn" />{a.step || "Starting"}</span>
        : <span className="truncate text-muted">
            <span className={a.ok ? "text-ok" : "text-thread"}>{a.ok ? (a.path === "learned" ? "Learned" : "Done") : "Not done"}</span>
            {"  "}{secs(a.ms)}{"  "}<span className={a.calls === 0 ? "text-ok" : ""}>{a.calls ?? 0} calls</span>{"  "}{money(a.cost)}
          </span>}
    </span>
  );
}
