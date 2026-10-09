"use client";

import { useEffect, useRef, useState } from "react";

// A device's live video, with a waiting state until the first frame arrives and a clear note when its engine is
// not running. Sits inside a positioned frame that sets the size. The caller changes `src` when the engine restarts.
export function LiveScreen({ src, label, offline, hint }: { src: string | null; label: string; offline?: boolean; hint?: string }) {
  const img = useRef<HTMLImageElement>(null);
  const [shown, setShown] = useState<string | null>(null); // the stream whose first frame has arrived
  const [retry, setRetry] = useState(0); // a stream that failed to open tries again by itself
  const url = src && retry ? `${src}${src.includes("?") ? "&" : "?"}r=${retry}` : src;
  const ready = !!url && shown === url;

  // Chrome keeps an MJPEG connection open after its <img> is gone, and allows six per host and port, so streams left
  // behind by switching would starve the next one. Cut each stream off explicitly when it is replaced.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const el = img.current;
    return () => { clearTimeout(timer.current); if (el) el.src = ""; };
  }, [url]);
  // An emptied src is our own cut-off, not a failure.
  const failed = (e: React.SyntheticEvent<HTMLImageElement>) => {
    if (!e.currentTarget.getAttribute("src")) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setRetry(r => r + 1), 1500);
  };

  return (
    <>
      {url && (
        // next/image cannot optimize or proxy a never-ending response.
        // eslint-disable-next-line @next/next/no-img-element
        <img ref={img} key={url} src={url} alt={`Live screen of ${label}`} draggable={false} onLoad={() => setShown(url)} onError={failed}
          className={`pointer-events-none block size-full object-cover transition-opacity duration-300 ${ready ? "opacity-100" : "opacity-0"}`} />
      )}
      {!ready && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
          {offline ? (
            <>
              <span className="size-3 rounded-full bg-thread" aria-hidden />
              <p className="text-flesh">{label} is not running</p>
              {hint && <p className="font-mono text-xs text-muted">{hint}</p>}
            </>
          ) : (
            <>
              <span className="size-10 animate-spin rounded-full border-2 border-dashed border-dawn [animation-duration:2.4s]" aria-hidden />
              <p className="text-muted">Connecting to {label}</p>
            </>
          )}
        </div>
      )}
    </>
  );
}
