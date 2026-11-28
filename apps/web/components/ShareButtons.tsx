"use client";
import { useEffect, useRef, useState } from "react";
import { WhatsAppButton } from "./WhatsAppButton";
import { shareTargets } from "../lib/share";

/** WhatsApp en un clic, et « Partager… » : les autres messageries, le partage du téléphone, la copie du lien. */
export function ShareButtons({ text, url, className = "" }: { text: string; url: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [native, setNative] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setMobile(/Android|iPhone|iPad|Mobi/i.test(navigator.userAgent));
    setNative(typeof navigator.share === "function");
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);
  const full = text.includes(url) ? text : `${text} ${url}`;
  return (
    <div ref={box} className={`relative flex flex-wrap gap-2 ${className}`}>
      <WhatsAppButton text={full} />
      <button type="button" aria-expanded={open} onClick={() => setOpen((x) => !x)}
        className="rounded-lg border border-line px-3 py-1.5 text-sm font-semibold text-muted hover:text-text">Partager…</button>
      {open && (
        <div role="menu" className="panel absolute left-0 top-full z-[60] mt-1 flex w-56 flex-col p-1 shadow-2xl">
          {native && (
            <button type="button" role="menuitem" onClick={() => { void navigator.share({ text, url }).catch(() => {}); setOpen(false); }}
              className="rounded-md px-3 py-2 text-left text-sm hover:bg-surface-2">📱 Partage du téléphone</button>
          )}
          {shareTargets(text, url, mobile).map((x) => (
            <a key={x.id} role="menuitem" href={x.href} target={x.href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer"
              onClick={() => setOpen(false)} className="rounded-md px-3 py-2 text-sm hover:bg-surface-2">{x.label}</a>
          ))}
          <button type="button" role="menuitem" onClick={() => { void navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); }}
            className="rounded-md px-3 py-2 text-left text-sm hover:bg-surface-2">{copied ? "Lien copié ✓" : "🔗 Copier le lien"}</button>
        </div>
      )}
    </div>
  );
}
