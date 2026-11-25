"use client";
import { useCallback, useEffect, useState } from "react";
import type { ChatAck, ChatMessage, RelayGameView, RelayRoundView } from "@chessarena/shared";
import { getSocket, type AuthProvider } from "../lib/socket";

/** Fusionne une partie mise à jour dans la ronde affichée (même ronde uniquement). */
export function mergeRelayGame(r: RelayRoundView, round: number, g: RelayGameView): RelayRoundView {
  if (r.currentRound !== round) return r;
  const list = r.gameList.some((x) => x.index === g.index) ? r.gameList.map((x) => (x.index === g.index ? g : x)) : [...r.gameList, g].sort((a, b) => a.index - b.index);
  return { ...r, gameList: list, live: list.some((x) => x.live), games: list.length, updatedAt: Date.now() };
}

/** Suit une retransmission : la ronde, chaque coup, le chat des spectateurs. Se réabonne après une coupure. */
export function useRelay(relayId: string, getAuth: AuthProvider) {
  const [round, setRound] = useState<RelayRoundView | null>(null);
  const [missing, setMissing] = useState(false);
  const [connected, setConnected] = useState(false);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const chatId = `relay:${relayId}`;

  useEffect(() => {
    const socket = getSocket(getAuth);
    const watch = () => {
      setConnected(true);
      socket.emit("relay:watch", { relayId }, (r) => {
        if (r.ok) { setRound(r.round); setMissing(false); } else setMissing(true);
      });
    };
    const onRound = (r: RelayRoundView) => { if (r.id === relayId) setRound(r); };
    const onGame = (p: { relayId: string; round: number; game: RelayGameView }) => {
      if (p.relayId === relayId) setRound((r) => (r ? mergeRelayGame(r, p.round, p.game) : r));
    };
    const onHistory = (p: { gameId: string; messages: ChatMessage[] }) => { if (p.gameId === chatId) setChat(p.messages); };
    const onMsg = (m: ChatMessage) => { if (m.gameId === chatId) setChat((c) => [...c.slice(-99), m]); };
    const onDisc = () => setConnected(false);
    socket.on("connect", watch);
    socket.on("disconnect", onDisc);
    socket.on("relay:round", onRound);
    socket.on("relay:game", onGame);
    socket.on("chat:history", onHistory);
    socket.on("chat:msg", onMsg);
    if (socket.connected) watch();
    return () => {
      socket.emit("relay:unwatch", { relayId });
      socket.off("connect", watch);
      socket.off("disconnect", onDisc);
      socket.off("relay:round", onRound);
      socket.off("relay:game", onGame);
      socket.off("chat:history", onHistory);
      socket.off("chat:msg", onMsg);
    };
  }, [relayId, getAuth, chatId]);

  const sendChat = useCallback((text: string) => new Promise<ChatAck>((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, code: "RATE_LIMITED" }), 5_000);
    getSocket(getAuth).emit("chat:send", { gameId: chatId, text }, (r) => { clearTimeout(t); resolve(r); });
  }), [getAuth, chatId]);

  const reportChat = useCallback((m: ChatMessage) => new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 5_000);
    getSocket(getAuth).emit("chat:report", { gameId: m.gameId, messageId: m.id }, (r) => { clearTimeout(t); resolve(r.ok); });
  }), [getAuth]);

  /** ronde déjà jouée (sans suivi en direct) */
  const loadRound = useCallback((n: number) => new Promise<RelayRoundView | null>((resolve) => {
    const t = setTimeout(() => resolve(null), 20_000);
    getSocket(getAuth).emit("relay:roundView", { relayId, round: n }, (r) => { clearTimeout(t); resolve(r.ok ? r.round : null); });
  }), [getAuth, relayId]);

  return { round, missing, connected, chat, sendChat, reportChat, loadRound };
}

/** Temps restant affiché (secondes) : la pendule du joueur au trait continue de tourner entre deux lectures. */
export function relayClock(g: RelayGameView, color: "w" | "b", now: number, receivedAt: number): number | null {
  const base = g.clocks[color];
  if (base === null) return null;
  if (!g.live || g.result || g.turn !== color || g.sans.length < 1) return base;
  return Math.max(0, base - Math.max(0, (now - receivedAt) / 1000));
}

export function formatClock(sec: number | null): string {
  if (sec === null) return "—";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** Analyse partagée d'une partie terminée : lue sur le serveur, ou envoyée après calcul. */
export function sharedReview(getAuth: AuthProvider) {
  return {
    get: (k: { relayId: string; round: number; index: number; plies: number }) => new Promise<unknown | null>((resolve) => {
      const t = setTimeout(() => resolve(null), 10_000);
      getSocket(getAuth).emit("relay:review", k, (r) => { clearTimeout(t); resolve(r.review); });
    }),
    // par HTTP : une analyse (~20 Ko) dépasse la taille maximale d'un message websocket
    save: (k: { relayId: string; round: number; index: number; sans: string[]; review: unknown }) => {
      void fetch("/api/relays/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(k) }).catch(() => {});
    },
  };
}
