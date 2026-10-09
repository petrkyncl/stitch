// Client for the Stitch engines: one Node process per device (the USB phone, and the emulators scripts/emulators.sh starts).
import { useEffect, useState, useSyncExternalStore } from "react";

export type DeviceDef = { id: string; label: string; port: number };

export const DEVICES: DeviceDef[] = [
  { id: "phone", label: "Phone (USB)", port: 4400 },
  // Emulator n has its engine on 4408 + 2n. Keep the count in step with `scripts/emulators.sh up N`.
  ...Array.from({ length: Number(process.env.NEXT_PUBLIC_EMULATORS || 6) }, (_, i) => i + 1)
    .map(n => ({ id: `emu${n}`, label: `Emulator ${n}`, port: 4408 + 2 * n })),
];

// Where the studio is looking: one device, or all of them side by side. Kept in the URL (?d=emu2, ?v=all) so a reload
// lands in the same place; switching never reloads the page. The prerender always shows the phone.
export type View = "one" | "all";
type Place = { device: DeviceDef; view: View };
const PRERENDER: Place = { device: DEVICES[0], view: "one" };
let place = PRERENDER;
if (typeof window !== "undefined") {
  const q = new URLSearchParams(window.location.search);
  place = { device: DEVICES.find(d => d.id === q.get("d")) ?? DEVICES[0], view: q.get("v") === "all" ? "all" : "one" };
}
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function goTo(next: { device?: string; view?: View }) {
  place = { device: DEVICES.find(d => d.id === next.device) ?? place.device, view: next.view ?? place.view };
  const q = new URLSearchParams();
  if (place.device.id !== "phone") q.set("d", place.device.id);
  if (place.view === "all") q.set("v", "all");
  window.history.replaceState(null, "", q.size ? `?${q}` : window.location.pathname);
  listeners.forEach(l => l());
}

export const usePlace = () => useSyncExternalStore(subscribe, () => place, () => PRERENDER);

export const engineUrl = (d: DeviceDef = place.device) => (d.id === "phone" && process.env.NEXT_PUBLIC_ENGINE) || `http://localhost:${d.port}`;
// Video on its own host and port, so it never queues behind the event streams of other open tabs.
export const videoUrl = (d: DeviceDef = place.device) => (d.id === "phone" && process.env.NEXT_PUBLIC_VIDEO) || `http://127.0.0.1:${d.port + 1}/stream.mjpg`;

// A device's connection, polled every few seconds. `offline` means its engine is not running at all.
export function useDeviceStatus(d: DeviceDef, enabled = true) {
  const [status, setStatus] = useState<Device | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    const poll = () => fetch(engineUrl(d) + "/api/device", { signal: AbortSignal.timeout(4000) })
      .then(r => r.json()).then((x: Device) => { if (!stop) setStatus(x); })
      .catch(() => { if (!stop) setStatus({ connected: false, offline: true }); });
    poll();
    const t = setInterval(poll, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [d, enabled]);
  return status;
}

export type MeterSnapshot = { calls: number; tokensIn: number; tokensOut: number; cost: number; ms: number };

export type RunPath = "learned" | "code" | "repaired" | "held" | "failed" | "stopped";

export type RunEvent = { type: string; kind?: string; text?: string; why?: string; frame?: string; at: number };

export type Run = MeterSnapshot & {
  id: string;
  chat?: number;
  session: number;
  task: string;
  path?: RunPath;
  ok?: boolean;
  capability?: string;
  error?: string;
  at: number;
  events: RunEvent[];
  data?: Record<string, string>[];
  reply?: string; // what the app answered after a send, when the request asked for it
};

export type App = { package: string; label: string; system?: boolean };

export const iconUrl = (pkg: string) => `${engineUrl()}/api/app-icon/${pkg}`;

export type Capability = {
  name: string;
  title: string;
  app?: string;
  approved: boolean;
  paramInfo: { name: string; description?: string; example?: string; default?: string }[];
  history?: { version: number; reason: string; at: string }[];
  version: number;
  description: string;
  params: string[];
  effect: "local" | "external";
  permissions: string[];
  status: "installed" | "held";
  reason?: string;
  tests?: { passed: number; total: number; last?: string };
  runs: number;
  steps: number;
};

// An action that sends, pays or deletes, waiting for a person to allow it.
export type Pending = { capability: string; title: string; app?: string; params: Record<string, string>; action: string; step?: string };
export type Decision = "once" | "always" | "deny";

export type EngineState = {
  session: number;
  chat?: number;
  busy: boolean;
  current: Run | null;
  pending: Pending | null;
  runs: Run[];
  capabilities: Capability[];
  granted: { permissions: string[]; effects: string[] };
  model: string;
  provider: string;
  hands: boolean;
  hasKey: boolean;
  boxes?: boolean;
  exploreModel?: string;
};

export type Device = {
  connected: boolean;
  offline?: boolean;
  started?: number;
  serial?: string;
  transport?: string;
  model?: string;
  android?: string;
  battery?: number;
  charging?: boolean;
  width?: number;
  height?: number;
  hands?: boolean;
  error?: string;
};

export type EngineEvent = {
  type: string;
  at: number;
  runId?: string;
  id?: string;
  text?: string;
  why?: string;
  frame?: string;
  idx?: number; // "frame" events: which step of the run the snapshot belongs to
  kind?: string;
  task?: string;
  session?: number;
  capabilities?: number;
  meter?: MeterSnapshot;
};

export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(engineUrl() + path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data as T;
}

export const money = (v?: number) => (!v ? "$0" : v < 0.01 ? "$" + v.toFixed(4) : "$" + v.toFixed(3));
export const secs = (ms?: number) => ((ms ?? 0) / 1000).toFixed(1) + " s";
