"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SngAck, SngCreatePayload, SngSnapshot } from "@chessarena/shared";
import type { ArenaSocket } from "../lib/socket";
import { myTournament } from "../lib/tournament";

/**
 * Sit & Go en direct : tables ouvertes (`sng:lobby`), tournois du joueur (`sng:update`,
 * poussé à chaque coup d'état : inscription, appariement, résultat, distribution).
 */
export function useTournament(socket: ArenaSocket, userId: string, inviteId: string | null = null) {
  /** tournoi ouvert par un lien d'invitation (?t=<id>), avant inscription */
  const [invite, setInvite] = useState<SngSnapshot | null>(null);
  const [lobby, setLobby] = useState<SngSnapshot[]>([]);
  const [mine, setMine] = useState<Map<string, SngSnapshot>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const upsert = (s: SngSnapshot) => setMine((m) => new Map(m).set(s.id, s));
    const list = () => socket.emit("sng:list", (tables) => setLobby(tables));
    socket.on("sng:lobby", setLobby);
    socket.on("sng:update", upsert);
    socket.on("connect", list);
    if (socket.connected) list();
    return () => {
      socket.off("sng:lobby", setLobby);
      socket.off("sng:update", upsert);
      socket.off("connect", list);
    };
  }, [socket]);

  const all = useMemo(() => {
    const m = new Map(mine);
    for (const t of lobby) if (!m.has(t.id) || t.players.some((p) => p.userId === userId)) m.set(t.id, t);
    return m;
  }, [lobby, mine, userId]);

  const current = useMemo(() => myTournament(all.values(), userId), [all, userId]);

  // lien d'invitation : on charge l'état du tournoi (et on le garde à jour s'il change)
  useEffect(() => {
    if (!inviteId) return;
    const load = () => socket.emit("sng:get", { tournamentId: inviteId }, (r) => {
      if (r.ok) setInvite(r.snapshot);
      else setError(r.code);
    });
    socket.on("connect", load);
    if (socket.connected) load();
    return () => { socket.off("connect", load); };
  }, [socket, inviteId]);
  useEffect(() => {
    if (!invite) return;
    const fresh = mine.get(invite.id) ?? lobby.find((t) => t.id === invite.id);
    if (fresh && fresh !== invite) setInvite(fresh);
  }, [mine, lobby, invite]);

  const handle = (key: string) => (r: SngAck) => {
    setBusy((b) => (b === key ? null : b));
    if (r.ok) setMine((m) => new Map(m).set(r.snapshot.id, r.snapshot));
    else setError(r.code);
  };

  /** Crée un tournoi (le créateur y est inscrit d'office). */
  const create = useCallback((p: SngCreatePayload) => {
    setBusy("create");
    setError(null);
    socket.emit("sng:create", p, handle("create"));
  }, [socket]);

  /** Rejoint un tournoi précis (lien d'invitation, ou tournoi créé par un joueur dans le lobby). */
  const join = useCallback((tournamentId: string) => {
    setBusy(tournamentId);
    setError(null);
    socket.emit("sng:join", { tournamentId }, handle(tournamentId));
  }, [socket]);

  const register = useCallback((formatId: string) => {
    setBusy(formatId);
    setError(null);
    socket.emit("sng:register", { formatId }, (r) => {
      setBusy(null);
      if (r.ok) setMine((m) => new Map(m).set(r.snapshot.id, r.snapshot));
      else setError(r.code);
    });
  }, [socket]);

  const unregister = useCallback((tournamentId: string) => {
    setBusy(tournamentId);
    socket.emit("sng:unregister", { tournamentId }, (r) => {
      setBusy(null);
      if (r.ok) setMine((m) => new Map(m).set(r.snapshot.id, r.snapshot));
      else setError(r.code);
    });
  }, [socket]);

  return { lobby, current, invite, register, unregister, create, join, busy, error };
}
