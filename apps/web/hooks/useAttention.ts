"use client";
import { useEffect, useRef } from "react";

/**
 * Onglet en arrière-plan : le titre clignote (« ♟ À toi de jouer ! ») quand c'est au joueur de jouer,
 * pour qu'il ne perde pas une partie de tournoi au temps. Si le navigateur a déjà autorisé les notifications
 * pour le site, une notification système est aussi envoyée au début d'une partie.
 */
export function useAttention(opts: { myTurn: boolean; gameId: string | null; opponent: string | null }): void {
  const { myTurn, gameId, opponent } = opts;
  const base = useRef<string | null>(null);
  const notified = useRef<string | null>(null);

  // notification système au début d'une partie (seulement si déjà autorisée : jamais de demande intempestive)
  useEffect(() => {
    if (!gameId || notified.current === gameId) return;
    notified.current = gameId;
    if (typeof document === "undefined" || !document.hidden) return;
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        const n = new Notification("Ta partie commence", { body: opponent ? `contre ${opponent}` : undefined, tag: `game-${gameId}` });
        n.onclick = () => { window.focus(); n.close(); };
      }
    } catch { /* navigateur sans notifications : sans gravité */ }
  }, [gameId, opponent]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (base.current === null) base.current = document.title;
    const restore = () => { if (base.current !== null) document.title = base.current; };
    if (!myTurn) { restore(); return; }
    let on = false;
    const tick = () => {
      if (!document.hidden) { restore(); return; }
      on = !on;
      document.title = on ? "♟ À toi de jouer !" : (base.current ?? "ChessAurum");
    };
    tick();
    const id = setInterval(tick, 1000);
    const vis = () => { if (!document.hidden) restore(); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", vis); restore(); };
  }, [myTurn]);
}
