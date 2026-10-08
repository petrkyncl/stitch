// Client for the Stitch engine (the Node process that holds the phone).
export const ENGINE = process.env.NEXT_PUBLIC_ENGINE || "http://localhost:4400";

export type MeterSnapshot = { calls: number; tokensIn: number; tokensOut: number; cost: number; ms: number };

export type Run = MeterSnapshot & {
  session: number;
  task: string;
  path: "learned" | "code" | "repaired" | "held" | "failed";
  ok: boolean;
  capability?: string;
  error?: string;
  at: number;
};

export type Capability = {
  name: string;
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

export type EngineState = {
  session: number;
  busy: boolean;
  runs: Run[];
  capabilities: Capability[];
  granted: { permissions: string[]; effects: string[] };
  model: string;
  hands: boolean;
  hasKey: boolean;
};

export type EngineEvent = {
  type: string;
  at: number;
  text?: string;
  why?: string;
  kind?: string;
  task?: string;
  session?: number;
  capabilities?: number;
  meter?: MeterSnapshot;
} & Partial<Run>;

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

export const money = (v: number) => (v === 0 ? "$0" : v < 0.01 ? "$" + v.toFixed(4) : "$" + v.toFixed(3));
export const secs = (ms: number) => (ms / 1000).toFixed(1) + "s";
