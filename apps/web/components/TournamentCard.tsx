"use client";
import { isOfficial, type TournamentCard } from "@chessarena/shared";
import { TC_LABEL } from "../lib/social";
import { formatMoney, remaining, startsIn, startsLabel, swissRoundsFor, weeklyLabel } from "../lib/tournament";

const SYSTEM = { swiss: "Suisse", arena: "Arena", ko: "Élimination directe" } as const;

/** Carte d'un tournoi (page Tournois, page d'un club). */
export function TournamentCardView({ c, now }: { c: TournamentCard; now: number }) {
  const format = c.teams ? `⚔️ Bataille de clubs ${c.arenaMinutes} min` : c.system === "arena" ? `Arena ${c.arenaMinutes} min` : c.system === "swiss" ? `Suisse ${c.totalRounds ?? swissRoundsFor(c.size)} rondes` : SYSTEM.ko;
  const live = c.status === "running";
  const official = isOfficial(c.createdBy);
  const fmtPts = (p: number | null) => (p === null ? "" : p % 1 ? `${Math.floor(p) || ""}½` : String(p));
  return (
    <a href={`/tournoi/${c.id}`} className={`panel flex h-full flex-col gap-2 p-3 transition-colors hover:border-neon/60 ${live ? "border-neon/40" : official ? "border-gold/30" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-display text-base font-bold">{c.name ?? (c.teams ? c.teams.map((x) => x.name).join(" vs ") : c.club ? `Tournoi · ${c.club.name}` : c.createdBy ? `Tournoi de ${c.createdBy}` : "Tournoi")}</p>
          {official && <p className="text-[11px] font-semibold uppercase tracking-[.12em] text-gold">★ Tournoi officiel</p>}
          <p className="text-xs text-muted">{format} · {TC_LABEL[c.timeControl]} · {c.buyInCents > 0 ? `entrée ${formatMoney(c.buyInCents, c.currency)}` : "gratuit"}</p>
          {c.repeatWeekly && c.startsAt && <p className="text-xs text-neon">🔁 {weeklyLabel(c.startsAt)}</p>}
          {c.club && c.name && <p className="truncate text-xs text-muted">Club : <span className="text-text">{c.club.name}</span></p>}
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${live ? "bg-neon/15 text-neon" : c.status === "registering" ? "bg-gold/15 text-gold" : "bg-surface-2 text-muted"}`}>
          {live ? (c.system === "arena" && c.arenaEndsAt ? `● ⏱ ${remaining(c.arenaEndsAt, now)}` : c.system === "swiss" ? `● Ronde ${c.currentRound}/${c.totalRounds}` : "● En cours")
            : c.status === "registering" ? `${c.players}/${c.size}` : "Terminé"}
        </span>
      </div>
      {c.prizePoolCents > 0 && (
        <p className="text-sm"><span className="font-semibold text-gold">💰 Dotation {formatMoney(c.prizePoolCents, c.currency)}</span>
          {c.addedCents > 0 && <span className="text-xs text-muted"> · dont {formatMoney(c.addedCents, c.currency)} garantis</span>}</p>
      )}
      {c.teams && <p className="truncate text-sm">{c.teams.map((x) => `${x.name}${c.status === "registering" ? "" : ` ${x.score}`}`).join(" · ")}</p>}
      {c.status === "registering" && (
        <p className="text-sm">{c.startsAt ? <><b className="text-gold">{startsLabel(c.startsAt)}</b> <span className="text-muted">({startsIn(c.startsAt, now)})</span></> : <span className="text-muted">Départ dès que c'est complet ou lancé par {c.createdBy ?? "l'organisateur"}</span>}</p>
      )}
      {c.leaders.length > 0 && (
        <ol className="flex flex-col gap-0.5 text-sm">
          {c.leaders.map((l, i) => (
            <li key={l.userId} className="flex items-center gap-2">
              <span className="w-5 text-muted">{c.status === "finished" ? ["🥇", "🥈", "🥉"][i] : i + 1}</span>
              <span className="min-w-0 flex-1 truncate">{l.userId}</span>
              {l.points !== null && <span className="tabular text-xs font-semibold">{fmtPts(l.points)}</span>}
            </li>
          ))}
        </ol>
      )}
      <p className="mt-auto text-xs text-muted">{c.status === "registering" ? (c.players ? `${c.players} inscrit${c.players > 1 ? "s" : ""}` : "Aucun inscrit pour l'instant : sois le premier") : `${c.players} joueurs`}{c.createdBy && !official ? ` · par ${c.createdBy}` : ""}</p>
    </a>
  );
}
