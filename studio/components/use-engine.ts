"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ENGINE, type Device, type EngineEvent, type EngineState, type MeterSnapshot, type Run } from "@/lib/engine";

const EMPTY: MeterSnapshot = { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0, ms: 0 };

// Engine state, the run in progress (built from the live stream), session markers and device status.
export function useEngine() {
  const [state, setState] = useState<EngineState | null>(null);
  const [live, setLive] = useState<Run | null>(null);
  const [device, setDevice] = useState<Device | null>(null);
  const [offline, setOffline] = useState(false);
  const [sessions, setSessions] = useState<{ session: number; at: number; capabilities: number }[]>([]);
  const [now, setNow] = useState(0); // set on the client only, the clock is meaningless during prerender
  const liveRef = useRef<Run | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api<EngineState>("/api/state");
      setState(s);
      setOffline(false);
      // Rejoin a run that started before this page loaded.
      if (s.current && !liveRef.current) { liveRef.current = { ...s.current }; setLive(liveRef.current); }
      if (!s.current) { liveRef.current = null; setLive(null); }
    } catch {
      setOffline(true);
    }
  }, []);

  const update = (fn: (r: Run) => Run) => {
    if (!liveRef.current) return;
    liveRef.current = fn(liveRef.current);
    setLive(liveRef.current);
  };

  useEffect(() => {
    const es = new EventSource(ENGINE + "/api/events");
    es.onerror = () => setOffline(true);
    es.onopen = () => { setOffline(false); refresh(); };
    es.onmessage = e => {
      const ev: EngineEvent = JSON.parse(e.data);
      const meter = ev.meter ?? EMPTY;
      switch (ev.type) {
        case "task":
          liveRef.current = { id: ev.id || String(ev.at), session: ev.session ?? 0, task: ev.task || "", at: ev.at, events: [], ...EMPTY };
          setLive(liveRef.current);
          setState(s => (s ? { ...s, busy: true } : s));
          break;
        case "session":
          setSessions(list => [...list, { session: ev.session ?? 0, at: ev.at, capabilities: ev.capabilities ?? 0 }]);
          refresh();
          break;
        case "run":
        case "registry":
          refresh();
          break;
        default:
          update(r => ({ ...r, ...meter, events: [...r.events, { type: ev.type, kind: ev.kind, text: ev.text, why: ev.why, at: ev.at }] }));
      }
    };
    return () => es.close();
  }, [refresh]);

  // Device status every few seconds; a ticking clock for the run in progress.
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try { const d = await api<Device>("/api/device"); if (!stop) setDevice(d); } catch { if (!stop) setDevice({ connected: false }); }
    };
    poll();
    const t = setInterval(poll, 5000);
    const tick = setInterval(() => setNow(Date.now()), 100);
    return () => { stop = true; clearInterval(t); clearInterval(tick); };
  }, []);

  return { state, live, device, offline, sessions, now, refresh };
}
