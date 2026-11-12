"use client";
import { useCallback, useEffect, useState } from "react";

/** Échiquier retourné (vue de l'autre camp) ; touche F comme sur Lichess. */
export function useFlip(resetKey?: unknown) {
  const [flipped, setFlipped] = useState(false);
  const flip = useCallback(() => setFlipped((f) => !f), []);
  useEffect(() => { setFlipped(false); }, [resetKey]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); flip(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flip]);
  return [flipped, flip] as const;
}
