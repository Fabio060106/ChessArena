"use client";
import { useEffect } from "react";

/** Boutons ⏮ ◀ ▶ ⏭ pour parcourir les positions d'une partie (0 = position initiale, last = dernière). */
export function MoveNav({ ply, last, go, compact = false }: { ply: number; last: number; go: (p: number) => void; compact?: boolean }) {
  const btn = `flex-1 rounded-lg bg-surface-2 px-3 ${compact ? "py-1.5 text-base" : "py-2 text-lg"} text-muted hover:text-text disabled:opacity-30`;
  return (
    <div className="flex gap-1.5">
      <button type="button" className={btn} onClick={() => go(0)} disabled={ply === 0} aria-label="Début">⏮</button>
      <button type="button" className={btn} onClick={() => go(ply - 1)} disabled={ply === 0} aria-label="Coup précédent">◀</button>
      <button type="button" className={btn} onClick={() => go(ply + 1)} disabled={ply >= last} aria-label="Coup suivant">▶</button>
      <button type="button" className={btn} onClick={() => go(last)} disabled={ply >= last} aria-label="Fin">⏭</button>
    </div>
  );
}

/** Flèches du clavier : ← → coup par coup, ↑ / Début au départ, ↓ / Fin à la dernière position. */
export function usePlyKeys(ply: number, last: number, go: (p: number) => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") go(ply - 1);
      else if (e.key === "ArrowRight") go(ply + 1);
      else if (e.key === "ArrowUp" || e.key === "Home") go(0);
      else if (e.key === "ArrowDown" || e.key === "End") go(last);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ply, last, go, enabled]);
}
