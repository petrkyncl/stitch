"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, engineUrl, type Device, type EngineEvent, type EngineState, type MeterSnapshot, type Run } from "@/lib/engine";

const EMPTY: MeterSnapshot = { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0, ms: 0 };

// Engine state, the run in progress (built from the live stream), session markers and device status.
export function useEngine() {
  const [state, setState] = useState<EngineState | null>(null);
  const [live, setLive] = useState<Run | null>(null);
  const [device, setDevice] = useState<Device | null>(null);
  const [offline, setOffline] = useState(false);
  const [sessions, setSessions] = useState<{ session: number; at: number; capabilities: number }[]>([]);
  // The engine's start time: the video reopens only when the engine really restarted, not on every hiccup of the
  // event stream (that used to blank the phone for a few seconds each time).
  const [epoch, setEpoch] = useState(0);
  const misses = useRef(0); // offline only after two failed checks in a row, not after one slow answer
  const [now, setNow] = useState(0); // set on the client only, the clock is meaningless during prerender
  const liveRef = useRef<Run | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api<EngineState>("/api/state");
      setState(s);
      misses.current = 0;
      setOffline(false);
      // Rejoin a run that started before this page loaded.
      if (s.current && !liveRef.current) { liveRef.current = { ...EMPTY, ...s.current }; setLive(liveRef.current); }
      if (!s.current) { liveRef.current = null; setLive(null); }
    } catch {
      misses.current += 1;
      if (misses.current >= 2) setOffline(true);
    }
  }, []);

  const update = (fn: (r: Run) => Run) => {
    if (!liveRef.current) return;
    liveRef.current = fn(liveRef.current);
    setLive(liveRef.current);
  };

  // Live events. On any error the stream is rebuilt after a second, so an engine restart heals by itself.
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const connect = () => {
      es = new EventSource(engineUrl() + "/api/events");
      es.onopen = () => { refresh(); };
      es.onerror = () => {
        refresh(); // only a failed state check says the engine is gone; the event stream drops for many reasons
        es?.close();
        if (!closed) retry = setTimeout(connect, 1000);
      };
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
          case "frame":
            // A step's snapshot arrives once it is saved, a moment after the step itself.
            update(r => ({ ...r, events: r.events.map((x, i) => (i === ev.idx ? { ...x, frame: ev.frame } : x)) }));
            break;
          case "ask":
            update(r => ({ ...r, ...meter, events: [...r.events, { type: ev.type, kind: ev.kind, text: ev.text, why: ev.why, frame: ev.frame, at: ev.at }] }));
            refresh(); // brings the pending request, so the prompt shows its buttons
            break;
          default:
            update(r => ({ ...r, ...meter, events: [...r.events, { type: ev.type, kind: ev.kind, text: ev.text, why: ev.why, frame: ev.frame, at: ev.at }] }));
        }
      };
    };
    connect();
    // Safety net: if an event was missed, the next poll brings the state back in line.
    const poll = setInterval(() => refresh(), 5000);
    return () => { closed = true; clearTimeout(retry); clearInterval(poll); es?.close(); };
  }, [refresh]);

  // Device status every few seconds; a ticking clock for the run in progress.
  useEffect(() => {
    let stop = false;
    let failed = 0;
    const poll = async () => {
      try {
        const d = await api<Device>("/api/device");
        failed = 0;
        if (stop) return;
        setDevice(d);
        if (d.started) setEpoch(e => (e === d.started ? e : d.started!));
      } catch {
        // One missed answer keeps what we knew; two in a row mean the engine is away.
        if (!stop && ++failed >= 2) setDevice({ connected: false });
      }
    };
    poll();
    const t = setInterval(poll, 5000);
    const tick = setInterval(() => setNow(Date.now()), 100);
    return () => { stop = true; clearInterval(t); clearInterval(tick); };
  }, []);

  return { state, live, device, offline, sessions, now, epoch, refresh };
}
