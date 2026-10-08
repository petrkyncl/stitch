"use client";

import { useEffect, useState } from "react";
import { ENGINE } from "@/lib/engine";

// Live phone screen: one screenshot at a time, next one only after the previous loaded.
export function Phone() {
  const [src, setSrc] = useState<string | null>(null);
  const [live, setLive] = useState(true);

  useEffect(() => {
    if (!live) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      if (stop) return;
      if (document.hidden) { timer = setTimeout(next, 1000); return; }
      const url = `${ENGINE}/api/screen.png?t=${Date.now()}`;
      const img = new Image();
      img.onload = () => { if (!stop) { setSrc(url); timer = setTimeout(next, 600); } };
      img.onerror = () => { timer = setTimeout(next, 2000); };
      img.src = url;
    };
    next();
    return () => { stop = true; clearTimeout(timer); };
  }, [live]);

  return (
    <>
      <div className="aspect-[1080/2340] w-full max-w-[320px] overflow-hidden rounded-[26px] border-2 border-line bg-black p-2">
        {src
          // A fresh screenshot every 600 ms; next/image optimization would only add latency here.
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={src} alt="Live phone screen" className="block size-full rounded-[18px] object-contain" />
          : <div className="grid size-full place-items-center text-center text-sm text-muted">Waiting for the phone</div>}
      </div>
      <label className="flex items-center gap-1.5 text-[13px] text-muted">
        <input type="checkbox" checked={live} onChange={e => setLive(e.target.checked)} /> Live screen
      </label>
    </>
  );
}
