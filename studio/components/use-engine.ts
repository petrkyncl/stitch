"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ENGINE, type EngineEvent, type EngineState, type MeterSnapshot } from "@/lib/engine";

export type LogLine = { id: number; kind: string; text: string; why?: string };

const EMPTY_METER: MeterSnapshot = { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0, ms: 0 };

// Engine state plus the live event stream: log lines and the meter of the task in progress.
export function useEngine() {
  const [state, setState] = useState<EngineState | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [meter, setMeter] = useState<MeterSnapshot>(EMPTY_METER);
  const [elapsed, setElapsed] = useState(0);
  const [offline, setOffline] = useState(false);
  const started = useRef(0);
  const nextId = useRef(0);

  const refresh = useCallback(async () => {
    try {
      setState(await api<EngineState>("/api/state"));
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  const push = useCallback((kind: string, text: string, why?: string) => {
    setLog(l => [...l.slice(-400), { id: nextId.current++, kind, text, why }]);
  }, []);

  // The stream's open event loads the first state, so there is no separate initial fetch.
  useEffect(() => {
    const es = new EventSource(ENGINE + "/api/events");
    es.onerror = () => setOffline(true);
    es.onopen = () => { setOffline(false); refresh(); };
    es.onmessage = e => {
      const ev: EngineEvent = JSON.parse(e.data);
      if (ev.meter) setMeter(ev.meter);
      switch (ev.type) {
        case "task":
          started.current = Date.now();
          setMeter(EMPTY_METER);
          setElapsed(0);
          push("task", ev.task || "");
          setState(s => (s ? { ...s, busy: true } : s));
          break;
        case "step":
          push(ev.kind || "step", ev.text || "", ev.why);
          break;
        case "session":
          push("session", `New session ${ev.session}. Memory cleared, ${ev.capabilities} capabilities loaded from disk.`);
          refresh();
          break;
        case "run":
          started.current = 0;
          setMeter({ calls: ev.calls ?? 0, tokensIn: ev.tokensIn ?? 0, tokensOut: ev.tokensOut ?? 0, cost: ev.cost ?? 0, ms: ev.ms ?? 0 });
          setElapsed(ev.ms ?? 0);
          refresh();
          break;
        case "registry":
          refresh();
          break;
        default:
          if (ev.text) push(ev.type, ev.text);
      }
    };
    const tick = setInterval(() => { if (started.current) setElapsed(Date.now() - started.current); }, 100);
    return () => { es.close(); clearInterval(tick); };
  }, [push, refresh]);

  return { state, log, meter, elapsed, offline, refresh, push };
}
