"use client";
import { useEffect, useState } from "react";
import { useGameAuth } from "../hooks/useMe";
import { answerChallenge, cancelChallenge, challengeLabel, initChallenges, useChallenges } from "../lib/challenges";

/** Secondes restantes avant expiration (mise à jour chaque seconde). */
function useSecondsLeft(expiresAt: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  return expiresAt ? Math.min(60, Math.max(0, Math.ceil((expiresAt - now) / 1000))) : 0; // horloges client / serveur décalées
}

/**
 * Défis entre amis, sur toutes les pages : fenêtre « X te défie » (Accepter / Refuser),
 * suivi du défi envoyé (Annuler), et message si le défi est refusé ou expire.
 */
export function ChallengeCenter() {
  const getAuth = useGameAuth();
  useEffect(() => { initChallenges(getAuth); }, [getAuth]);
  const { incoming, outgoing, notice } = useChallenges();
  const first = incoming[0];
  const leftIn = useSecondsLeft(first?.expiresAt);
  const leftOut = useSecondsLeft(outgoing?.expiresAt);
  if (!first && !outgoing && !notice) return null;
  return (
    <div className="pointer-events-none fixed inset-x-2 bottom-3 z-[90] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-4 sm:items-end">
      {first && (
        <div role="alertdialog" aria-label="Défi reçu" className="panel pointer-events-auto w-full max-w-[360px] border-neon/60 p-3 shadow-2xl">
          <p className="text-sm"><span aria-hidden>⚔️ </span><a href={`/profil/${encodeURIComponent(first.from)}`} className="font-semibold hover:underline">{first.from}</a> te défie</p>
          <p className="text-xs text-muted">{challengeLabel(first.timeControl)} · partie classée, sans mise · {leftIn} s pour répondre</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => answerChallenge(first.id, true)} className="neon-btn flex-1 rounded-lg px-3 py-2 text-sm font-semibold">Accepter</button>
            <button type="button" onClick={() => answerChallenge(first.id, false)} className="flex-1 rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted hover:text-text">Refuser</button>
          </div>
          {incoming.length > 1 && <p className="mt-1 text-[11px] text-muted">+ {incoming.length - 1} autre{incoming.length > 2 ? "s" : ""} défi{incoming.length > 2 ? "s" : ""} en attente</p>}
        </div>
      )}
      {outgoing && (
        <div role="status" className="panel pointer-events-auto flex w-full max-w-[360px] items-center gap-2 p-3 shadow-xl">
          <p className="min-w-0 flex-1 text-sm">Défi envoyé à <span className="font-semibold">{outgoing.to}</span>
            <span className="block text-xs text-muted">{challengeLabel(outgoing.timeControl)} · en attente ({leftOut} s)</span></p>
          <button type="button" onClick={cancelChallenge} className="rounded-lg bg-surface-2 px-3 py-1.5 text-xs text-muted hover:text-text">Annuler</button>
        </div>
      )}
      {notice && <p role="status" className="panel pointer-events-auto w-full max-w-[360px] p-3 text-sm shadow-xl">{notice}</p>}
    </div>
  );
}
