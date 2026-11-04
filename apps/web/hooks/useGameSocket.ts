"use client";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { Color, GameStartEvent, GameStateEvent, QueueJoinPayload } from "@chessarena/shared";
import { getSocket, type AuthProvider } from "../lib/socket";
import { gameReducer, initialView, type PendingMove } from "../lib/gameReducer";
import { ClockSync, displayedClocks } from "../lib/clock";
import { enqueuePremove, takeNextPremove, tryLocalMove, type Premove, type PromotionPiece } from "../lib/moves";
import { moveSound, sound } from "../lib/sound";

/**
 * Hook de partie temps réel.
 *
 *  - synchro d'horloge haute précision (base monotone, rafale de pings à la connexion) ;
 *  - coups optimistes avec rollback sur refus serveur (ack) ;
 *  - file de pré-moves ILLIMITÉE, exécutée DANS le gestionnaire de `game:state` :
 *    le coup part dans le même tick que la réception de la position, sans attendre
 *    un rendu React (0 frame de latence côté client) ;
 *  - sons (coup, prise, roque, échec, début et fin de partie) ;
 *  - signaux de focus (visibilitychange / blur), dédupliqués.
 *
 * L'état « chaud » (position serveur, coup en attente, file de pré-moves) vit dans des refs
 * mises à jour de façon synchrone : deux messages reçus dans le même tick voient un état cohérent.
 */
export function useGameSocket(userId: string, getAuth: AuthProvider) {
  const socket = getSocket(getAuth);
  const [view, dispatch] = useReducer(gameReducer, initialView);
  const syncRef = useRef(new ClockSync());

  const hot = useRef<{
    start: GameStartEvent | null;
    server: GameStateEvent | null;
    pending: PendingMove | null;
    premoves: Premove[];
    myColor: Color;
    playing: boolean;
  }>({ start: null, server: null, pending: null, premoves: [], myColor: "w", playing: false });

  const setPremoves = useCallback((premoves: Premove[]) => {
    hot.current.premoves = premoves;
    dispatch({ type: "set_premoves", premoves });
  }, []);

  /** Envoi immédiat d'un coup déjà validé localement. */
  const emitMove = useCallback((uci: string, fen: string, ply: number) => {
    const h = hot.current;
    if (!h.start) return;
    const pending = { uci, ply, fen };
    h.pending = pending;
    dispatch({ type: "optimistic_move", pending });
    socket.emit("game:move", { gameId: h.start.gameId, uci, ply }, (ack) => {
      if (ack.ok) {
        if (hot.current.pending?.ply === ack.ply - 1) hot.current.pending = null;
        dispatch({ type: "move_acked", ply: ack.ply });
      } else {
        hot.current.pending = null;
        setPremoves([]); // la position a divergé : la suite prévue n'a plus de sens
        dispatch({ type: "move_rejected", code: ack.code });
      }
    });
  }, [socket, setPremoves]);

  const myTurnNow = () => {
    const h = hot.current;
    return h.playing && !!h.server && h.server.turn === h.myColor && !h.pending;
  };

  /** Exécute la tête de la file de pré-moves si c'est au joueur de jouer. */
  const firePremove = useCallback(() => {
    const h = hot.current;
    if (!myTurnNow() || h.premoves.length === 0 || !h.server) return;
    const { move, rest } = takeNextPremove(h.server.fen, h.premoves);
    setPremoves(rest);
    if (!move) return;
    sound.play(moveSound(move));
    emitMove(move.uci, move.fen, h.server.ply);
  }, [emitMove, setPremoves]);

  // ─── Connexion & événements serveur ──────────────────────────────────────
  useEffect(() => {
    const onConnect = () => dispatch({ type: "connected" });
    const onDisconnect = () => { hot.current.pending = null; dispatch({ type: "disconnected" }); };
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("queue:joined", (p) => dispatch({ type: "queued", timeControl: p.timeControl, stake: p.stake }));
    socket.on("queue:left", () => dispatch({ type: "queue_left" }));
    socket.on("game:start", (start) => {
      const h = hot.current;
      const same = h.start?.gameId === start.gameId;
      h.start = start;
      h.myColor = start.black.userId === userId ? "b" : "w";
      h.playing = true;
      h.pending = null;
      if (!same) { h.server = null; h.premoves = []; sound.play("start"); }
      dispatch({ type: "start", start, userId });
    });
    socket.on("game:state", (state) => {
      const h = hot.current;
      if (!h.start || state.gameId !== h.start.gameId) return;
      if (h.server && state.ply < h.server.ply) return;
      const prev = h.server;
      const mine = h.pending && state.ply === h.pending.ply + 1 && state.lastMoveUci === h.pending.uci;
      if (prev && state.ply === prev.ply + 1 && state.lastMoveUci && !mine) {
        const u = state.lastMoveUci;
        const m = tryLocalMove(prev.fen, u.slice(0, 2), u.slice(2, 4), (u[4] as PromotionPiece | undefined) || undefined);
        if (m) sound.play(moveSound(m));
      }
      h.server = state;
      h.pending = null;
      dispatch({ type: "state", state });
      firePremove(); // même tick : 0 frame de latence perçue
    });
    socket.on("game:presence", (presence) => dispatch({ type: "presence", presence, userId }));
    socket.on("game:net", (net) => dispatch({ type: "net", net }));
    socket.on("game:draw", (d) => dispatch({ type: "draw", gameId: d.gameId, offeredBy: d.offeredBy }));
    socket.on("game:over", (over) => {
      const h = hot.current;
      if (h.start?.gameId === over.gameId) {
        h.playing = false;
        h.premoves = [];
        h.pending = null;
        if (over.termination !== "aborted") {
          const won = over.result === "1/2-1/2" ? null : (over.result === "1-0") === (h.myColor === "w");
          sound.play(won === null ? "draw" : won ? "win" : "loss");
        }
      }
      dispatch({ type: "over", over });
    });
    socket.on("error", (e) => dispatch({ type: "error", code: e.code }));
    socket.on("session:mode", (session) => dispatch({ type: "session_mode", session }));
    if (socket.connected) onConnect();
    return () => {
      for (const ev of ["connect", "disconnect", "queue:joined", "queue:left", "game:start", "game:state",
        "game:presence", "game:net", "game:draw", "game:over", "error", "session:mode"] as const) socket.off(ev);
    };
  }, [socket, userId, firePremove]);

  // ─── Synchronisation d'horloge ───────────────────────────────────────────
  const [localRtt, setLocalRtt] = useState<number | null>(null);
  useEffect(() => {
    const sync = syncRef.current;
    const ping = () => {
      if (!socket.connected) return;
      const t0 = performance.now();
      socket.emit("time:ping", Date.now(), (serverTs) => {
        sync.add(t0, performance.now(), serverTs);
        setLocalRtt(sync.rttMs === null ? null : Math.round(sync.rttMs));
      });
    };
    // rafale à la connexion (le meilleur des 6 échantillons fixe l'offset), puis entretien
    const burst = () => { for (let i = 0; i < 6; i++) setTimeout(ping, i * 120); };
    burst();
    const id = setInterval(ping, 3_000);
    socket.on("connect", burst);
    return () => { clearInterval(id); socket.off("connect", burst); };
  }, [socket]);

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
  /** Coup de l'utilisateur : joué tout de suite si c'est son tour, sinon ajouté à la file de pré-moves. */
  const playOrPremove = useCallback((from: string, to: string, promotion?: PromotionPiece): boolean => {
    const h = hot.current;
    if (!h.playing || !h.server) return false;
    if (myTurnNow() && h.premoves.length === 0) {
      const local = tryLocalMove(h.server.fen, from, to, promotion);
      if (!local) return false;
      sound.play(moveSound(local));
      emitMove(local.uci, local.fen, h.server.ply);
      return true;
    }
    const base = h.pending?.fen ?? h.server.fen;
    const next = enqueuePremove(base, h.premoves, { from, to, promotion }, h.myColor);
    if (!next) return false;
    sound.play("premove");
    setPremoves(next);
    firePremove(); // cas limite : le trait est revenu pendant que la file n'était pas vide
    return true;
  }, [emitMove, setPremoves, firePremove]);

  const cancelPremoves = useCallback(() => {
    if (hot.current.premoves.length) setPremoves([]);
  }, [setPremoves]);

  const joinQueue = useCallback((p: QueueJoinPayload) => {
    dispatch({ type: "clear_error" });
    socket.emit("queue:join", p);
  }, [socket]);
  const leaveQueue = useCallback(() => socket.emit("queue:leave"), [socket]);
  const resign = useCallback(() => {
    const id = hot.current.start?.gameId;
    if (id) socket.emit("game:resign", { gameId: id });
  }, [socket]);

  /** Nulle : proposer (ou accepter si l'adversaire la propose déjà), accepter, refuser. */
  const draw = useCallback((action: "offer" | "accept" | "decline") => {
    const id = hot.current.start?.gameId;
    if (id) socket.emit("game:draw", { gameId: id, action });
  }, [socket]);

  return { view, socket, sync: syncRef.current, localRtt, joinQueue, leaveQueue, playOrPremove, cancelPremoves, resign, draw };
}

/**
 * Pendules extrapolées. Ne provoque AUCUN rendu React par frame : `subscribe` reçoit
 * les valeurs à chaque frame et les composants écrivent directement dans le DOM.
 */
export function useClockTicker(
  state: Pick<GameStateEvent, "whiteMs" | "blackMs" | "turn" | "ply" | "serverTs"> | null,
  sync: ClockSync,
  stopped: boolean,
) {
  const listeners = useRef(new Set<(c: Record<Color, number>) => void>());
  const latest = useRef<Record<Color, number>>({ w: state?.whiteMs ?? 0, b: state?.blackMs ?? 0 });

  useEffect(() => {
    if (!state) return;
    let raf = 0;
    const loop = () => {
      const now = performance.now();
      const c = displayedClocks(state, sync.offsetMs, now, stopped);
      latest.current = c;
      for (const l of listeners.current) l(c);
      if (!stopped) raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [state, stopped, sync]);

  return useCallback((fn: (c: Record<Color, number>) => void) => {
    listeners.current.add(fn);
    fn(latest.current);
    return () => { listeners.current.delete(fn); };
  }, []);
}
