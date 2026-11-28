"use client";
import { useEffect, useState } from "react";
import type { TournamentCard, TournamentsPageResponse } from "@chessarena/shared";
import { pickOfficial, remaining, startsIn } from "../lib/tournament";
import { TC_LABEL } from "../lib/social";

export function OfficialBanner({ className = "" }: { className?: string }) {
  const [card, setCard] = useState<TournamentCard | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    const load = () => void fetch("/api/tournaments", { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as TournamentsPageResponse) : null))
      .then((d) => { if (alive && d) setCard(pickOfficial(d, Date.now())); })
      .catch(() => {});
    load();
    const a = setInterval(load, 60_000);
    const b = setInterval(() => setNow(Date.now()), 30_000);
    return () => { alive = false; clearInterval(a); clearInterval(b); };
  }, []);
  if (!card) return null;
  const live = card.status === "running";
  return (
    <div className={className}>
      <a href={`/tournoi/${card.id}`} className="panel flex items-center gap-3 border-gold/40 p-3 hover:border-gold">
        <span className="text-2xl text-gold" aria-hidden>★</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{card.name}</span>
          <span className="block truncate text-xs text-muted">
            {TC_LABEL[card.timeControl]} · gratuit · {live ? `encore ${remaining(card.arenaEndsAt!, now)} · ${card.players} joueurs` : `${startsIn(card.startsAt!, now)}${card.players ? ` · ${card.players} inscrit${card.players > 1 ? "s" : ""}` : ""}`}
          </span>
        </span>
        <span className="shrink-0 rounded-lg border border-gold/50 px-2.5 py-1.5 text-xs font-semibold text-gold">{live ? "Rejoindre" : "S'inscrire"}</span>
      </a>
    </div>
  );
}
