"use client";
import { useCallback, useEffect, useState } from "react";
import type { BetPlaceAck, BetView, OddsView, PredictionPick, PredictionsMine } from "@chessarena/shared";
import { getSocket, type AuthProvider } from "../lib/socket";

/** Pronostics en jetons d'une retransmission : cotes en direct, mes paris, solde, meilleurs pronostiqueurs. */
export function usePredictions(relayId: string, getAuth: AuthProvider) {
  const [odds, setOdds] = useState<Record<string, OddsView>>({});
  const [mine, setMine] = useState<PredictionsMine | null>(null);
  const [lastSettled, setLastSettled] = useState<BetView | null>(null);
  const k = (round: number, index: number) => `${round}:${index}`;

  const refreshMine = useCallback(() => {
    getSocket(getAuth).emit("bet:mine", (r) => setMine(r));
  }, [getAuth]);

  useEffect(() => {
    const socket = getSocket(getAuth);
    const load = () => {
      socket.emit("odds:list", { relayId }, (list) => setOdds(Object.fromEntries(list.map((v) => [k(v.round, v.index), v]))));
      refreshMine();
      setTimeout(refreshMine, 2_500); // nouveau compte : les jetons de bienvenue arrivent juste après la connexion
    };
    const onOdds = (v: OddsView) => { if (v.relayId === relayId) setOdds((o) => ({ ...o, [k(v.round, v.index)]: v })); };
    const onSettled = (b: BetView) => { setLastSettled(b); refreshMine(); };
    socket.on("connect", load);
    socket.on("relay:odds", onOdds);
    socket.on("bet:settled", onSettled);
    if (socket.connected) load();
    return () => { socket.off("connect", load); socket.off("relay:odds", onOdds); socket.off("bet:settled", onSettled); };
  }, [relayId, getAuth, refreshMine]);

  const place = useCallback((round: number, index: number, pick: PredictionPick, stakeCents: number, version: number) => new Promise<BetPlaceAck>((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, code: "TIMEOUT" }), 10_000);
    getSocket(getAuth).emit("bet:place", { relayId, round, index, pick, stakeCents, version }, (r) => {
      clearTimeout(t);
      if (r.ok) setMine((m) => (m ? { ...m, balanceCents: r.balanceCents, bets: [r.bet, ...m.bets] } : m));
      resolve(r);
    });
  }), [getAuth, relayId]);

  return { oddsFor: (round: number, index: number) => odds[k(round, index)] ?? null, mine, place, lastSettled, dismissSettled: () => setLastSettled(null) };
}

export const BET_ERRORS: Record<string, string> = {
  ODDS_CHANGED: "La cote vient de changer (nouveau coup) : vérifie la nouvelle cote et mise à nouveau.",
  ODDS_PENDING: "Cote en cours de calcul après le dernier coup : réessaie dans une seconde.",
  SUSPENDED: "Marché suspendu : l'issue est quasi certaine.",
  MARKET_CLOSED: "La partie est terminée : plus de pronostic possible.",
  NO_MARKET: "Pas encore de cote pour cette partie.",
  STAKE_LIMIT: "Mise de 1 à 25 jetons.",
  EXPOSURE_LIMIT: "Tu as déjà engagé 50 jetons sur cette partie (maximum).",
  INSUFFICIENT: "Solde de jetons insuffisant.",
};
