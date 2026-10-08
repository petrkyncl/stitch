"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, iconUrl, type App } from "@/lib/engine";

// Optional: tell the agent which app to use. The list comes from the phone (Stitch Hands), your apps first.
export function AppPicker({ value, onChange }: { value: string | null; onChange: (pkg: string | null) => void }) {
  const [apps, setApps] = useState<App[]>([]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => { if (open && !apps.length) api<App[]>("/api/apps").then(setApps).catch(() => {}); }, [open, apps.length]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? apps.filter(a => a.label.toLowerCase().includes(t) || a.package.includes(t)) : apps;
  }, [apps, q]);
  const selected = apps.find(a => a.package === value);

  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-2 rounded-full border px-3 py-1 text-sm ${value ? "border-dawn/60 text-flesh" : "border-line text-muted hover:text-flesh"}`}>
        {value ? <><AppIcon pkg={value} label={selected?.label || value} size={18} /> {selected?.label || value}</> : "Any app"}
        <span aria-hidden className="text-xs">▾</span>
      </button>
      {value && (
        <button type="button" onClick={() => onChange(null)} aria-label="Let the agent choose the app" className="ml-1 text-sm text-muted hover:text-flesh">×</button>
      )}
      {open && (
        <div className="absolute bottom-full left-0 z-40 mb-2 flex max-h-96 w-80 flex-col overflow-hidden rounded-xl border border-line bg-night-2 shadow-2xl">
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search apps on the phone"
            className="border-b border-line bg-transparent px-3 py-2.5 text-flesh outline-none placeholder:text-muted/70" />
          <div className="overflow-y-auto">
            <Item label="Any app" hint="the agent decides" onClick={() => { onChange(null); setOpen(false); }} />
            {!apps.length && <p className="px-3 py-3 text-sm text-muted">Connect the phone to load its apps.</p>}
            {shown.map((a, i) => (
              <div key={a.package}>
                {(i === 0 || shown[i - 1].system !== a.system) && (
                  <p className="px-3 pt-3 pb-1 font-mono text-[10px] tracking-wider text-muted uppercase">{a.system ? "Preinstalled" : "Your apps"}</p>
                )}
                <Item pkg={a.package} label={a.label} active={a.package === value} onClick={() => { onChange(a.package); setOpen(false); setQ(""); }} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Item({ pkg, label, hint, active, onClick }: { pkg?: string; label: string; hint?: string; active?: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-night-3 ${active ? "bg-night-3" : ""}`}>
      {pkg ? <AppIcon pkg={pkg} label={label} size={28} /> : <span className="grid size-7 place-items-center rounded-lg border border-dashed border-line text-xs text-muted">?</span>}
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{label}</span>
        <span className="truncate font-mono text-[11px] text-muted">{hint || pkg}</span>
      </span>
    </button>
  );
}

// The app's real icon from the phone; its first letter while it loads or when the phone is away.
export function AppIcon({ pkg, label, size = 24 }: { pkg: string; label: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <span style={{ width: size, height: size, fontSize: size * 0.5 }} className="grid shrink-0 place-items-center rounded-lg bg-night-3 font-semibold text-flesh">{label.charAt(0).toUpperCase()}</span>;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={iconUrl(pkg)} alt="" width={size} height={size} onError={() => setFailed(true)} className="shrink-0 rounded-lg" />;
}
