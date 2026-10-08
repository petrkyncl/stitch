// Client for the Stitch engine (the Node process that holds the phone).
// Every device the studio can drive: the USB phone, plus the emulators scripts/emulators.sh starts, one engine each.
export const DEVICES = [
  { id: "phone", label: "Phone (USB)", port: 4400 },
  ...[1, 2, 3, 4].map(n => ({ id: `emu${n}`, label: `Emulator ${n}`, port: 4408 + 2 * n })),
];
// Picked with ?d=emu2, so each tab can hold a different device. Read in the browser only; the prerender uses the phone.
const picked = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("d");
export const DEVICE = DEVICES.find(d => d.id === picked) ?? DEVICES[0];
const isPhone = DEVICE.id === "phone";
export const ENGINE = (isPhone && process.env.NEXT_PUBLIC_ENGINE) || `http://localhost:${DEVICE.port}`;
// Video on its own host and port, so it never queues behind the event streams of other open tabs.
export const VIDEO = (isPhone && process.env.NEXT_PUBLIC_VIDEO) || `http://127.0.0.1:${DEVICE.port + 1}/stream.mjpg`;

export type MeterSnapshot = { calls: number; tokensIn: number; tokensOut: number; cost: number; ms: number };

export type RunPath = "learned" | "code" | "repaired" | "held" | "failed" | "stopped";

export type RunEvent = { type: string; kind?: string; text?: string; why?: string; frame?: string; at: number };

export type Run = MeterSnapshot & {
  id: string;
  session: number;
  task: string;
  path?: RunPath;
  ok?: boolean;
  capability?: string;
  error?: string;
  at: number;
  events: RunEvent[];
  data?: Record<string, string>[];
};

export type App = { package: string; label: string; system?: boolean };

export const iconUrl = (pkg: string) => `${ENGINE}/api/app-icon/${pkg}`;

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
};

export type Device = {
  connected: boolean;
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
  kind?: string;
  task?: string;
  session?: number;
  capabilities?: number;
  meter?: MeterSnapshot;
};

export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(ENGINE + path, body === undefined ? {} : {
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
