"use client";

import { useEffect, useRef } from "react";
import type { LogLine } from "./use-engine";

const KIND_COLOR: Record<string, string> = {
  gap: "text-dawn",
  broken: "text-dawn",
  compile: "text-dawn",
  install: "text-ok",
  done: "text-ok",
  route: "text-ok",
  use: "text-ok",
  test: "text-flesh",
  blocked: "text-thread",
  held: "text-thread",
  error: "text-thread",
};

export function Log({ lines }: { lines: LogLine[] }) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [lines]);

  if (!lines.length) {
    return <p className="text-sm text-muted">Nothing yet. Every screen the agent reads and every tap it makes will show up here.</p>;
  }
  return (
    <ol ref={ref} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto font-mono text-[13px]">
      {lines.map(l => {
        if (l.kind === "session") {
          return <li key={l.id} className="mt-3 border-t border-dashed border-line pt-3 text-center text-dawn">{l.text}</li>;
        }
        if (l.kind === "task") {
          return (
            <li key={l.id} className="mt-3 grid grid-cols-[72px_minmax(0,1fr)] gap-2.5 rounded bg-night-3 px-2 py-1.5">
              <span className="pt-0.5 text-[11px] tracking-wider text-muted uppercase">task</span>
              <span className="font-sans text-[15px] font-medium text-flesh">{l.text}</span>
            </li>
          );
        }
        return (
          <li key={l.id} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2.5 rounded px-2 py-1 odd:bg-night-2">
            <span className={`pt-px text-[11px] tracking-wider uppercase ${KIND_COLOR[l.kind] || "text-muted"}`}>{l.kind}</span>
            <span className="break-words">
              {l.text}
              {l.why && <span className="text-muted"> {l.why}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
