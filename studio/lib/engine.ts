// Client for the Stitch engine (the Node process that holds the phone).
export const ENGINE = process.env.NEXT_PUBLIC_ENGINE || "http://localhost:4400";
// Video on its own host and port, so it never queues behind the event streams of other open tabs.
export const VIDEO = process.env.NEXT_PUBLIC_VIDEO || "http://127.0.0.1:4401/stream.mjpg";

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
