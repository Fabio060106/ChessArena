"use client";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { Color, QueueJoinPayload } from "@chessarena/shared";
import { getSocket, type AuthProvider } from "../lib/socket";
import { gameReducer, initialView, isMyTurn } from "../lib/gameReducer";
import { bestSample, displayedClocks, offsetFromPing, type OffsetSample } from "../lib/clock";
import { resolvePremove, tryLocalMove, type Premove, type PromotionPiece } from "../lib/moves";

/**
 * Hook de partie temps réel.
 *  - synchronisation d'horloge (offset serveur) et extrapolation locale de la pendule ;
 *  - coups optimistes avec rollback sur refus serveur (ack) ;
 *  - pré-moves (1 en attente, exécuté dès que le trait revient) ;
 *  - signaux de focus (visibilitychange / blur), dédupliqués.
 */
export function useGameSocket(userId: string, getAuth: AuthProvider) {
  const socket = getSocket(getAuth);
  const [view, dispatch] = useReducer(gameReducer, initialView);
  const viewRef = useRef(view);
  viewRef.current = view;
  const offsetRef = useRef(0);

  // ─── Connexion & événements serveur ──────────────────────────────────────
  useEffect(() => {
    const onConnect = () => dispatch({ type: "connected" });
    const onDisconnect = () => dispatch({ type: "disconnected" });
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("queue:joined", (p) => dispatch({ type: "queued", timeControl: p.timeControl, stake: p.stake }));
    socket.on("queue:left", () => dispatch({ type: "queue_left" }));
    socket.on("game:start", (start) => dispatch({ type: "start", start, userId }));
    socket.on("game:state", (state) => dispatch({ type: "state", state }));
    socket.on("game:presence", (presence) => dispatch({ type: "presence", presence, userId }));
    socket.on("game:over", (over) => dispatch({ type: "over", over }));
    socket.on("error", (e) => dispatch({ type: "error", code: e.code }));
    socket.on("session:mode", (session) => dispatch({ type: "session_mode", session }));
    if (socket.connected) onConnect();
    return () => {
      for (const ev of ["connect", "disconnect", "queue:joined", "queue:left", "game:start", "game:state",
        "game:presence", "game:over", "error", "session:mode"] as const) socket.off(ev);
    };
  }, [socket, userId]);

  // ─── Synchronisation d'horloge (affichage) ───────────────────────────────
  useEffect(() => {
    const samples: OffsetSample[] = [];
    const ping = () => {
      if (!socket.connected) return;
      const t0 = Date.now();
      socket.emit("time:ping", t0, (serverTs) => {
        samples.push(offsetFromPing(t0, Date.now(), serverTs));
        if (samples.length > 8) samples.shift();
        offsetRef.current = bestSample(samples)?.offsetMs ?? 0;
      });
    };
    ping();
    const id = setInterval(ping, 5_000);
    socket.on("connect", ping);
    return () => { clearInterval(id); socket.off("connect", ping); };
  }, [socket]);

  // ─── Envoi d'un coup (optimiste) ─────────────────────────────────────────
  const sendMove = useCallback((from: string, to: string, promotion?: PromotionPiece): boolean => {
    const v = viewRef.current;
    if (!v.start || !v.server || !isMyTurn(v)) return false;
    const local = tryLocalMove(v.server.fen, from, to, promotion);
    if (!local) return false;
    const ply = v.server.ply;
    dispatch({ type: "optimistic_move", pending: { uci: local.uci, ply, fen: local.fen } });
    socket.emit("game:move", { gameId: v.start.gameId, uci: local.uci, ply }, (ack) => {
      if (ack.ok) dispatch({ type: "move_acked", ply: ack.ply });
      else dispatch({ type: "move_rejected", code: ack.code });
    });
    return true;
  }, [socket]);

  /** Coup joué par l'utilisateur : coup immédiat si c'est son tour, sinon pré-move. */
  const playOrPremove = useCallback((from: string, to: string, promotion?: PromotionPiece): boolean => {
    const v = viewRef.current;
    if (v.phase !== "playing") return false;
    if (isMyTurn(v)) return sendMove(from, to, promotion);
    dispatch({ type: "set_premove", premove: { from, to, promotion } });
    return false; // la pièce revient à sa case ; le pré-move est surligné
  }, [sendMove]);

  const cancelPremove = useCallback(() => dispatch({ type: "set_premove", premove: null }), []);

  // ─── Exécution du pré-move dès que le trait revient ──────────────────────
  useEffect(() => {
    const pm: Premove | null = view.premove;
    if (!pm || !view.server || !isMyTurn(view)) return;
    const resolved = resolvePremove(view.server.fen, pm);
    if (!resolved) return void dispatch({ type: "set_premove", premove: null });
    sendMove(pm.from, pm.to, (resolved.uci[4] as PromotionPiece | undefined) ?? undefined);
  }, [view, sendMove]);

  // ─── Signaux de focus (signal faible anti-triche, jamais une preuve) ─────
  useEffect(() => {
    if (view.phase !== "playing" || !view.start) return;
    const gameId = view.start.gameId;
    let focused = document.visibilityState === "visible" && document.hasFocus();
    const set = (now: boolean) => {
      if (now === focused) return; // blur + visibilitychange = un seul événement
      focused = now;
      socket.emit("game:signal", { gameId, kind: now ? "focus_regained" : "focus_lost", clientTs: Date.now() });
    };
    const onVis = () => set(document.visibilityState === "visible" && document.hasFocus());
    const onBlur = () => set(false);
    const onFocus = () => set(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [socket, view.phase, view.start]);

  // ─── Actions ─────────────────────────────────────────────────────────────
  const joinQueue = useCallback((p: QueueJoinPayload) => {
    dispatch({ type: "clear_error" });
    socket.emit("queue:join", p);
  }, [socket]);
  const leaveQueue = useCallback(() => socket.emit("queue:leave"), [socket]);
  const resign = useCallback(() => {
    const id = viewRef.current.start?.gameId;
    if (id) socket.emit("game:resign", { gameId: id });
  }, [socket]);

  return { view, offsetRef, joinQueue, leaveQueue, playOrPremove, cancelPremove, resign };
}

/**
 * Pendules affichées, extrapolées à chaque frame. Ne re-rend que si la valeur
 * visible change (dixième de seconde) pour éviter 60 rendus/s inutiles.
 */
export function useDisplayedClocks(
  state: { whiteMs: number; blackMs: number; turn: Color; ply: number; serverTs: number } | null,
  offsetRef: React.RefObject<number>,
  stopped: boolean,
): Record<Color, number> {
  const [clocks, setClocks] = useState<Record<Color, number>>({ w: state?.whiteMs ?? 0, b: state?.blackMs ?? 0 });
  useEffect(() => {
    if (!state) return;
    let raf = 0;
    let last = "";
    const loop = () => {
      const c = displayedClocks(state, offsetRef.current ?? 0, Date.now(), stopped);
      const key = `${Math.floor(c.w / 100)}|${Math.floor(c.b / 100)}`;
      if (key !== last) { last = key; setClocks(c); }
      if (!stopped) raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [state, stopped, offsetRef]);
  return clocks;
}
