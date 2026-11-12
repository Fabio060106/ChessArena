"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatAck, ChatMessage, Color, GameNetEvent, GameOverEvent, GameStartEvent, GameStateEvent, PresenceEvent } from "@chessarena/shared";
import { getSocket, type AuthProvider } from "../lib/socket";
import { ClockSync } from "../lib/clock";
import { finalFromPgn, nextHistory } from "../lib/gameReducer";
import { mergeChat } from "../lib/chat";
import { tryLocalMove, type PromotionPiece } from "../lib/moves";
import { moveSound, sound } from "../lib/sound";

export interface WatchView {
  status: "connecting" | "watching" | "over" | "missing";
  start: GameStartEvent | null;
  state: GameStateEvent | null;
  moves: Array<string | null>;
  fen: string | null;
  lastMove: string | null;
  over: GameOverEvent | null;
  chat: ChatMessage[];
  drawOffer: Color | null;
  spectators: number;
  tournamentId: string | null;
  net: GameNetEvent | null;
  /** joueur déconnecté (forfait à venir) */
  away: PresenceEvent | null;
  connected: boolean;
}

const empty: WatchView = {
  status: "connecting", start: null, state: null, moves: [], fen: null, lastMove: null, over: null, chat: [],
  drawOffer: null, spectators: 0, tournamentId: null, net: null, away: null, connected: false,
};

/**
 * Spectateur d'une partie en cours : état complet à l'arrivée (coups, chat), puis le direct.
 * Le spectateur n'écrit que dans le chat des spectateurs, que les joueurs ne voient jamais.
 */
export function useWatch(gameId: string, getAuth: AuthProvider) {
  const socket = getSocket(getAuth);
  const [v, setV] = useState<WatchView>(empty);
  const syncRef = useRef(new ClockSync());
  const cur = useRef<WatchView>(empty);
  const set = useCallback((f: (s: WatchView) => WatchView) => setV((s) => (cur.current = f(s))), []);

  useEffect(() => {
    const join = () => {
      set((s) => ({ ...s, connected: true }));
      socket.emit("watch:start", { gameId }, (r) => {
        if (!r.ok) {
          if (r.code === "IS_PLAYER") { window.location.replace("/play"); return; }
          set((s) => (s.over ? s : { ...s, status: "missing" }));
          return;
        }
        const { start, state, moves, chat, drawOffer, spectators, tournamentId } = r.snapshot;
        set((s) => ({
          ...s, status: "watching", start, state, moves, fen: state.fen, lastMove: state.lastMoveUci,
          chat: mergeChat(s.chat, chat), drawOffer, spectators, tournamentId,
        }));
      });
    };
    socket.on("connect", join);
    socket.on("disconnect", () => set((s) => ({ ...s, connected: false })));
    socket.on("game:state", (st) => {
      if (st.gameId !== gameId) return;
      const prev = cur.current.state;
      if (prev && st.ply < prev.ply) return;
      if (prev && st.ply === prev.ply + 1 && st.lastMoveUci) {
        const u = st.lastMoveUci;
        const m = tryLocalMove(prev.fen, u.slice(0, 2), u.slice(2, 4), (u[4] as PromotionPiece | undefined) || undefined);
        if (m) sound.play(moveSound(m));
      }
      set((s) => ({ ...s, state: st, fen: st.fen, lastMove: st.lastMoveUci, moves: nextHistory(s.moves, s.state, st) }));
    });
    socket.on("game:over", (o) => {
      if (o.gameId !== gameId) return;
      set((s) => ({ ...s, status: "over", over: o, drawOffer: null, away: null, ...pickFinal(finalFromPgn(o.pgn, s.moves.length)) }));
    });
    socket.on("chat:msg", (m) => { if (m.gameId === gameId) set((s) => ({ ...s, chat: mergeChat(s.chat, [m]) })); });
    socket.on("game:spectators", (p) => { if (p.gameId === gameId) set((s) => ({ ...s, spectators: p.count })); });
    socket.on("game:draw", (d) => { if (d.gameId === gameId) set((s) => ({ ...s, drawOffer: d.offeredBy })); });
    socket.on("game:net", (n) => { if (n.gameId === gameId) set((s) => ({ ...s, net: n })); });
    socket.on("game:presence", (p) => { if (p.gameId === gameId) set((s) => ({ ...s, away: p.connected ? null : p })); });
    if (socket.connected) join();
    return () => {
      socket.emit("watch:stop", { gameId });
      for (const ev of ["connect", "disconnect", "game:state", "game:over", "chat:msg", "game:spectators", "game:draw", "game:net", "game:presence"] as const) socket.off(ev);
    };
  }, [socket, gameId, set]);

  // horloge : même synchronisation que pour les joueurs (affichage seulement)
  useEffect(() => {
    const sync = syncRef.current;
    const ping = () => {
      if (!socket.connected) return;
      const t0 = performance.now();
      socket.emit("time:ping", Date.now(), (serverTs) => sync.add(t0, performance.now(), serverTs));
    };
    const burst = () => { for (let i = 0; i < 6; i++) setTimeout(ping, i * 120); };
    burst();
    const id = setInterval(ping, 5_000);
    socket.on("connect", burst);
    return () => { clearInterval(id); socket.off("connect", burst); };
  }, [socket]);

  const sendChat = useCallback((text: string) => new Promise<ChatAck>((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, code: "RATE_LIMITED" }), 5_000);
    socket.emit("chat:send", { gameId, text }, (r) => { clearTimeout(t); resolve(r); });
  }), [socket, gameId]);

  return { view: v, sync: syncRef.current, sendChat, socket };
}

function pickFinal(f: ReturnType<typeof finalFromPgn>): Partial<WatchView> {
  return { ...(f.moves ? { moves: f.moves } : {}), ...(f.displayFen ? { fen: f.displayFen } : {}), ...(f.lastMove !== undefined ? { lastMove: f.lastMove } : {}) };
}
