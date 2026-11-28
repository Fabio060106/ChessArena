"use client";
import { useEffect, useState } from "react";
import type { TournamentCard } from "@chessarena/shared";
import { remaining, startsIn } from "../lib/tournament";

/**
 * Rappel sur toutes les pages (hors page de jeu) : « ton tournoi commence dans 4 min » ou « ton tournoi est en cours ».
 * Sans lui, un inscrit qui lit son répertoire rate le départ et perd sa première partie par forfait.
 * Interroge le serveur toutes les 30 s (toutes les 10 s dans les 15 dernières minutes).
 */
export function TournamentReminder() {
  const [t, setT] = useState<TournamentCard | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const soon = !!t && (t.status === "running" || (!!t.startsAt && Date.parse(t.startsAt) - now < 15 * 60_000));
  useEffect(() => {
    let alive = true;
    const load = () => fetch("/api/my-tournament", { cache: "no-store" })
      .then(async (r) => { if (r.ok && alive) setT(((await r.json()) as { tournament: TournamentCard | null }).tournament); })
      .catch(() => {});
    void load();
    const poll = setInterval(load, soon ? 10_000 : 30_000);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => { alive = false; clearInterval(poll); clearInterval(tick); };
  }, [soon]);
  if (!t) return null;
  const startsInMs = t.startsAt ? Date.parse(t.startsAt) - now : null;
  // à venir sans heure, ou à plus de 2 h : pas de bandeau (la page Tournois suffit)
  if (t.status === "registering" && (startsInMs === null || startsInMs > 2 * 3600_000)) return null;
  const name = t.name ?? "Ton tournoi";
  const urgent = t.status === "running" || (startsInMs !== null && startsInMs < 10 * 60_000);
  return (
    <div role="status" className="mx-auto mb-2 flex max-w-[1400px] items-center gap-3 px-2 sm:px-3 lg:px-6" aria-label="Rappel de tournoi">
      <a href={`/play?t=${t.id}`} className={`panel flex w-full items-center gap-3 px-3 py-2 text-sm ${urgent ? "border-neon/60 bg-neon/10" : "border-gold/40"}`}>
        <span aria-hidden className={urgent ? "animate-pulse text-neon" : "text-gold"}>●</span>
        <span className="min-w-0 flex-1 leading-snug">
          {t.status === "running"
            ? <><b>{name}</b> est en cours{t.system === "arena" && t.arenaEndsAt ? ` (⏱ ${remaining(t.arenaEndsAt, now)})` : ""} : tes parties t'attendent.</>
            : <><b>{name}</b> commence <b className={urgent ? "text-neon" : "text-gold"}>{startsIn(t.startsAt!, now)}</b><span className="max-sm:hidden">. Sois sur la page Jouer à l'heure</span>.</>}
        </span>
        <span className={`shrink-0 font-semibold ${urgent ? "text-neon" : "text-gold"}`}>Jouer →</span>
      </a>
    </div>
  );
}
