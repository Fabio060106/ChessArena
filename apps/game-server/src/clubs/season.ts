import { isOfficial, SEASON_PARTICIPATION, SEASON_POINTS, type ClubSeason, type SngSnapshot } from "@chessarena/shared";

/** Début du mois (UTC) contenant `now`, et son nom « AAAA-MM ». */
export function monthOf(now: number): { start: number; month: string } {
  const d = new Date(now);
  return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}` };
}

/**
 * Classement du mois d'un club : pour chaque tournoi du club terminé ce mois-ci, points de place
 * (10, 7, 5, 4, 3, puis 2 pour toute participation). Bataille de clubs : seuls les joueurs de ce club comptent,
 * classés entre eux. Départage : points, victoires, podiums, moins de tournois joués, pseudo.
 */
export function clubSeason(snapshots: readonly SngSnapshot[], slug: string, now = Date.now()): ClubSeason {
  return placementSeason(snapshots, (s) => {
    const battle = !!s.teamBattle?.teams.some((t) => t.slug === slug);
    if (s.club?.slug !== slug && !battle) return null;
    return (p) => !battle || s.club?.slug === slug || p.team === slug;
  }, now);
}

/** Tournois officiels du mois : tous les joueurs classés de chaque tournoi officiel terminé. */
export function officialSeason(snapshots: readonly SngSnapshot[], now = Date.now()): ClubSeason {
  return placementSeason(snapshots, (s) => (isOfficial(s.createdBy) ? () => true : null), now);
}

/**
 * Points de place cumulés sur les tournois terminés du mois en cours. `pick` dit si un tournoi compte et,
 * si oui, quels joueurs y sont classés (entre eux).
 */
export function placementSeason(
  snapshots: readonly SngSnapshot[],
  pick: (s: SngSnapshot) => ((p: SngSnapshot["players"][number]) => boolean) | null,
  now = Date.now(),
): ClubSeason {
  const { start, month } = monthOf(now);
  const rows = new Map<string, ClubSeason["rows"][number]>();
  let tournaments = 0;
  for (const s of snapshots) {
    if (s.status !== "finished" || !s.finishedAt || Date.parse(s.finishedAt) < start) continue;
    const keep = pick(s);
    if (!keep) continue;
    const ranked = s.players.filter((p) => p.finalRank && keep(p)).sort((a, b) => a.finalRank! - b.finalRank!);
    if (ranked.length < 2) continue;
    tournaments++;
    ranked.forEach((p, i) => {
      const r = rows.get(p.userId) ?? { userId: p.userId, points: 0, played: 0, wins: 0, podiums: 0 };
      r.points += SEASON_POINTS[i] ?? SEASON_PARTICIPATION;
      r.played++;
      if (i === 0) r.wins++;
      if (i < 3) r.podiums++;
      rows.set(p.userId, r);
    });
  }
  return {
    month, tournaments,
    rows: [...rows.values()].sort((a, b) => b.points - a.points || b.wins - a.wins || b.podiums - a.podiums || a.played - b.played || a.userId.localeCompare(b.userId)),
  };
}
