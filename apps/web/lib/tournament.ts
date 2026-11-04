import type { Cents, Currency, SngMatchView, SngPlayerView, SngSnapshot } from "@chessarena/shared";

/**
 * Vues dérivées d'un Sit & Go pour le HUD — pures, testées.
 * Les montants viennent tels quels du serveur (centimes entiers) : le client n'invente aucun chiffre.
 */

export function formatMoney(cents: Cents, currency: Currency): string {
  const v = (cents / 100).toLocaleString("fr-FR", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 });
  return currency === "EUR" ? `${v} €` : `${v} jetons`;
}

export interface PrizeBreakdown {
  /** total des inscriptions (table complète : taille × entrée) */
  grossCents: Cents;
  /** rake de la plateforme : projeté tant que le tournoi n'est pas fini, réel ensuite */
  rakeCents: Cents;
  rakePct: number;
  /** true une fois le rake effectivement prélevé (tournoi terminé) */
  rakeSettled: boolean;
  sponsorCents: Cents;
  /** cagnotte nette distribuée (calculée par le serveur) */
  poolCents: Cents;
  /** gain par place (1er, 2e…) */
  payouts: Array<{ rank: number; cents: Cents; pct: number }>;
}

/**
 * Le serveur publie la cagnotte NETTE (`prizePoolCents` = inscriptions − rake + dotation).
 * Le rake affiché en est déduit, donc toujours cohérent avec ce qui sera distribué.
 */
export function prizeBreakdown(s: SngSnapshot): PrizeBreakdown {
  const grossCents = s.buyInCents * s.size;
  const rakeCents = grossCents + s.sponsorAddedCents - s.prizePoolCents;
  const finalPay = new Map(s.players.filter((p) => p.finalRank !== null).map((p) => [p.finalRank!, p.payoutCents]));
  const payouts = s.payoutBps.map((bps, i) => ({
    rank: i + 1,
    cents: s.status === "finished" && finalPay.has(i + 1) ? finalPay.get(i + 1)! : Math.floor((s.prizePoolCents * bps) / 10_000),
    pct: bps / 100,
  }));
  return {
    grossCents, rakeCents, rakePct: s.rakeBps / 100, rakeSettled: s.status === "finished",
    sponsorCents: s.sponsorAddedCents, poolCents: s.prizePoolCents, payouts,
  };
}

export interface StandingRow {
  userId: string;
  rating: number;
  /** rang affiché : rang final s'il est connu, sinon rang provisoire */
  rank: number;
  state: "alive" | "playing" | "eliminated" | "winner" | "waiting";
  /** gain acquis ou garanti à ce stade (centimes), 0 sinon */
  payoutCents: Cents;
  eliminatedRound: number | null;
}

const ACTIVE: ReadonlyArray<SngPlayerView["status"]> = ["registered", "playing", "winner", "eliminated", "locking"];

/** Classement live : vainqueur, puis joueurs encore en lice (par tête de série), puis éliminés (les plus tardifs d'abord). */
export function liveStandings(s: SngSnapshot): StandingRow[] {
  const players = s.players.filter((p) => ACTIVE.includes(p.status));
  const score = (p: SngPlayerView) =>
    p.finalRank ?? (p.status === "winner" ? 1 : p.status === "eliminated" ? 1000 - (p.eliminatedRound ?? 0) : 0);
  const sorted = [...players].sort((a, b) => score(a) - score(b) || (a.seed ?? 99) - (b.seed ?? 99) || b.rating - a.rating);
  return sorted.map((p, i) => ({
    userId: p.userId,
    rating: p.rating,
    rank: p.finalRank ?? i + 1,
    state: p.status === "winner" ? "winner" : p.status === "eliminated" ? "eliminated" : p.status === "playing" ? "playing"
      : s.status === "registering" ? "waiting" : "alive",
    payoutCents: p.payoutCents,
    eliminatedRound: p.eliminatedRound,
  }));
}

export function roundLabel(round: number, totalRounds: number): string {
  const fromEnd = totalRounds - round;
  if (fromEnd === 0) return "Finale";
  if (fromEnd === 1) return "Demi-finales";
  if (fromEnd === 2) return "Quarts de finale";
  return `Tour ${round + 1}`;
}

/**
 * Appariements du tour en cours. `currentRound` (serveur) est 1-based : numéro du premier tour
 * non terminé, 0 quand tous le sont → on montre alors le dernier tour (finale jouée).
 */
export function currentPairings(s: SngSnapshot): { round: number; label: string; matches: SngMatchView[] } | null {
  if (s.rounds.length === 0) return null;
  const round = s.currentRound > 0 ? s.currentRound - 1 : s.rounds.length - 1;
  return { round, label: roundLabel(round, s.rounds.length - 1), matches: s.rounds[round] ?? [] };
}

/** Le tournoi « courant » du joueur : inscrit ou en cours, sinon le dernier terminé. */
export function myTournament(snapshots: Iterable<SngSnapshot>, userId: string): SngSnapshot | null {
  let best: SngSnapshot | null = null;
  const rank = (t: SngSnapshot) => (t.status === "running" ? 3 : t.status === "registering" ? 2 : t.status === "finished" ? 1 : 0);
  for (const t of snapshots) {
    const me = t.players.find((p) => p.userId === userId);
    if (!me || me.status === "unregistered" || me.status === "refunded") continue;
    if (!best || rank(t) > rank(best) || (rank(t) === rank(best) && t.createdAt > best.createdAt)) best = t;
  }
  return best;
}
