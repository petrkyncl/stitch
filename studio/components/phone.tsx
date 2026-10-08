"use client";

import { useState } from "react";
import { ENGINE } from "@/lib/engine";

// Live phone video: the engine streams MJPEG frames as soon as the screen changes.
export function Phone() {
  const [live, setLive] = useState(true);
  return (
    <>
      <div className="aspect-[1080/2340] w-full max-w-[320px] overflow-hidden rounded-[28px] border-2 border-line bg-black">
        {live
          // An MJPEG stream; next/image cannot optimize or proxy a never-ending response.
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={`${ENGINE}/api/stream.mjpg`} alt="Live phone screen" className="block size-full object-cover" />
          : <div className="grid size-full place-items-center text-center text-sm text-muted">Live screen is off</div>}
      </div>
      <label className="flex items-center gap-1.5 text-[13px] text-muted">
        <input type="checkbox" checked={live} onChange={e => setLive(e.target.checked)} /> Live screen
      </label>
    </>
  );
}
