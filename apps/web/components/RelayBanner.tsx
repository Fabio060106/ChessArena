"use client";
import { useEffect, useState } from "react";
import type { RelaySummary } from "@chessarena/shared";
import { matchScore, nextRound, untilText } from "../lib/relayFormat";

/**
 * Bandeau « grand tournoi » : visible quand une partie est en direct, ou commence dans moins de 2 h.
 * Un clic ouvre la retransmission.
 */
export function RelayBanner({ className = "" }: { className?: string }) {
  const [list, setList] = useState<RelaySummary[]>([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    const load = () => void fetch("/api/relays", { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as { relays: RelaySummary[] }).relays : null))
      .then((l) => { if (alive && l) setList(l); })
      .catch(() => {});
    load();
    const a = setInterval(load, 60_000);
    const b = setInterval(() => setNow(Date.now()), 30_000);
    return () => { alive = false; clearInterval(a); clearInterval(b); };
  }, []);
  const r = list.find((x) => x.live) ?? list.find((x) => { const n = nextRound(x.rounds, now); return n && n.startsAt! - now < 2 * 3_600_000; });
  if (!r) return null;
  const score = matchScore(r.standings);
  const next = r.live ? null : nextRound(r.rounds, now);
  return (
    <div className={className}>
    <a href={`/retransmissions/${r.id}`} className="panel flex items-center gap-3 border-neon/40 p-3 hover:border-neon">
      <span className="text-2xl" aria-hidden>🏆</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{r.name}</span>
        <span className="block truncate text-xs text-muted">
          {score ? `${score.text} · ` : ""}
          {r.live ? `${r.roundName ?? "Partie"} en cours` : next ? `${next.name} ${untilText(next.startsAt!, now)}` : ""}
        </span>
      </span>
      {r.live
        ? <span className="shrink-0 text-xs font-semibold text-danger"><span className="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-danger align-middle" />En direct</span>
        : <span className="shrink-0 text-xs font-semibold text-neon">Voir →</span>}
    </a>
    </div>
  );
}
