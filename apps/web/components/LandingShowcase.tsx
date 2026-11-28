"use client";
import { useEffect, useState } from "react";
import type { SngStatus, SngSystem, TimeControlId } from "@chessarena/shared";
import { TC_LABEL } from "../lib/social";
import { remaining, startsIn, startsLabel } from "../lib/tournament";

interface Showcase {
  nextOfficial: { id: string; name: string | null; system: SngSystem; timeControl: TimeControlId; status: SngStatus; startsAt: string | null; arenaEndsAt: string | null; players: number } | null;
  playing: number;
  online: number;
}

/** Page d'accueil : le prochain rendez-vous officiel et l'activité du moment (si elle est parlante). */
export function LandingShowcase() {
  const [d, setD] = useState<Showcase | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    fetch("/api/showcase", { cache: "no-store" }).then(async (r) => (r.ok ? setD((await r.json()) as Showcase) : null)).catch(() => {});
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const t = d?.nextOfficial;
  return (
    <div className="flex flex-col gap-2">
      {t && (
        <a href={`/tournoi/${t.id}`} className="panel flex items-center gap-3 border-gold/40 p-3 hover:border-gold">
          <span className="text-2xl text-gold" aria-hidden>★</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-semibold uppercase tracking-[.12em] text-gold">{t.status === "running" ? "Tournoi officiel en cours" : "Prochain tournoi officiel"}</span>
            <span className="block truncate font-semibold">{t.name}</span>
            <span className="block text-xs text-muted">
              {TC_LABEL[t.timeControl]} · gratuit · {t.status === "running" && t.arenaEndsAt ? `encore ${remaining(t.arenaEndsAt, now)}, on peut arriver en cours de route` : t.startsAt ? `${startsLabel(t.startsAt)} (${startsIn(t.startsAt, now)})` : ""}
            </span>
          </span>
        </a>
      )}
      {d && d.playing >= 6 && (
        <p className="text-center text-xs text-muted"><span className="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-win align-middle" />{d.playing} joueurs en partie en ce moment</p>
      )}
    </div>
  );
}
