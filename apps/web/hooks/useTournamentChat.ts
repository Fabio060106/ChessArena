"use client";
import { useCallback, useEffect, useState } from "react";
import type { ChatAck, ChatMessage } from "@chessarena/shared";
import type { Socket } from "socket.io-client";
import { mergeChat } from "../lib/chat";

/**
 * Chat d'un tournoi : historique à l'arrivée, puis le direct (même salon que les mises à jour du tournoi).
 * Les participants écrivent ; ceux qui suivent le tournoi lisent.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useTournamentChat(socket: Socket<any, any>, tournamentId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const key = tournamentId ? `tournament:${tournamentId}` : null;
  useEffect(() => {
    setMessages([]);
    if (!tournamentId || !key) return;
    const load = () => socket.emit("sng:chat", { tournamentId }, (r: { ok: boolean; messages?: ChatMessage[] }) => { if (r.ok && r.messages) setMessages((c) => mergeChat(c, r.messages!)); });
    const onMsg = (m: ChatMessage) => { if (m.gameId === key) setMessages((c) => mergeChat(c, [m])); };
    socket.on("chat:msg", onMsg);
    socket.on("connect", load);
    if (socket.connected) load();
    return () => { socket.off("chat:msg", onMsg); socket.off("connect", load); };
  }, [socket, tournamentId, key]);
  const send = useCallback((text: string) => new Promise<ChatAck>((res) => {
    if (!key) return res({ ok: false, code: "NO_GAME" });
    socket.emit("chat:send", { gameId: key, text }, (r: ChatAck) => res(r));
  }), [socket, key]);
  const report = useCallback((m: ChatMessage) => new Promise<boolean>((res) => {
    socket.emit("chat:report", { gameId: m.gameId, messageId: m.id }, (r: { ok: boolean }) => res(r.ok));
  }), [socket]);
  return { messages, send, report };
}
