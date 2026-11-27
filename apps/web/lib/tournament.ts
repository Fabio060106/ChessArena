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
  // « en jeu » seulement pendant une partie ; un exempt ou un qualifié qui attend est « en lice »
  const inGame = new Set(s.rounds.flat().filter((m) => m.status === "playing").flatMap((m) => [m.p1, m.p2]));
  const score = (p: SngPlayerView) =>
    p.finalRank ?? (p.status === "winner" ? 1 : p.status === "eliminated" ? 1000 - (p.eliminatedRound ?? 0) : 0);
  const sorted = [...players].sort((a, b) => score(a) - score(b) || (a.seed ?? 99) - (b.seed ?? 99) || b.rating - a.rating);
  return sorted.map((p, i) => ({
    userId: p.userId,
    rating: p.rating,
    rank: p.finalRank ?? i + 1,
    state: p.status === "winner" ? "winner" : p.status === "eliminated" ? "eliminated" : p.status === "playing" && inGame.has(p.userId) ? "playing"
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
  if (fromEnd <= 6) return `${2 ** fromEnd}es de finale`; // 8es, 16es, 32es, 64es
  return `Tour ${round + 1}`;
}

/** Tableau d'un tournoi à `players` joueurs : taille (puissance de 2), exempts au 1er tour, nombre de tours. */
export function bracketInfo(players: number): { bracket: number; byes: number; rounds: number } {
  let bracket = 2;
  while (bracket < players) bracket *= 2;
  return { bracket, byes: bracket - players, rounds: Math.log2(bracket) };
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

/** Nombre de joueurs engagés : inscrits pendant les inscriptions, puis ceux réellement au départ. */
export function fieldSize(s: SngSnapshot): number {
  return s.status === "registering" ? s.size : s.players.filter((p) => p.seed !== null).length || s.size;
}

/** Le joueur attend-il sans partie (exempt, qualifié, ou partie finie au suisse) en attendant la fin du tour ? */
export function waitingInfo(s: SngSnapshot, userId: string): "bye" | "qualified" | "done" | null {
  if (s.status !== "running") return null;
  const me = s.players.find((p) => p.userId === userId);
  if (!me || me.status !== "playing") return null;
  const r = s.currentRound > 0 ? s.rounds[s.currentRound - 1] : undefined;
  const m = r?.find((x) => x.p1 === userId || x.p2 === userId);
  if (!m) return null;
  if (isSwiss(s)) return m.result === "bye" ? "bye" : m.status === "done" ? "done" : null;
  if (m.status === "done" && m.p2 === null && m.round === 1) return "bye";
  if (m.status === "done" && m.winner === userId) return "qualified";
  return null;
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

/**
 * Détail d'un match à élimination directe : chaque partie jouée (« ½-½ · revanche ½-½ · Armageddon ½-½ »)
 * et pourquoi le vainqueur passe, pour qu'une nulle finale ne paraisse pas absurde.
 */
export function matchDetail(m: SngMatchView): { score: string; why: string | null } {
  if (m.p2 === null && m.round === 1) return { score: "qualifié", why: "exempt au premier tour" };
  const played = m.games.filter((g) => g.result !== null);
  if (!played.length) return { score: "—", why: null };
  const score = played.map((g) => {
    const tag = g.kind === "rematch" ? "revanche " : g.kind === "armageddon" ? "Armageddon " : "";
    if (g.termination === "aborted") return `${tag}1er coup non joué`;
    return tag + (g.result === "1/2-1/2" ? "½-½" : g.result!);
  }).join(" · ");
  const last = played.at(-1)!;
  let why: string | null = null;
  if (m.status === "done" && m.winner) {
    if (last.termination === "aborted") why = `${m.winner === last.white ? last.black : last.white} n'a pas joué son premier coup`;
    else if (last.kind === "armageddon" && last.result === "1/2-1/2") why = "nulle à l'Armageddon : les Noirs passent";
  }
  return { score, why };
}

/** Règles du tableau, en clair. */
export const KNOCKOUT_RULES = [
  "Élimination directe : une partie par match, le vainqueur passe au tour suivant.",
  "Nulle : revanche avec les couleurs inversées ; encore nulle : Armageddon (les Noirs passent en cas de nulle).",
  "Chaque partie démarre toute seule : 45 s pour jouer son premier coup, sinon le match est perdu.",
  "Pas de revanche hors tableau pendant le tournoi ; une revanche après coup est une partie normale, hors tournoi.",
];

// ─── Système suisse ─────────────────────────────────────────────────────────
export const isSwiss = (s: Pick<SngSnapshot, "system">) => s.system === "swiss";

/** Rondes d'un suisse à `players` joueurs (même règle que le serveur) : de quoi départager, sans rencontre répétée. */
export function swissRoundsFor(players: number, chosen = 0): number {
  const auto = players <= 2 ? 1 : Math.min(players - 1, Math.max(3, Math.ceil(Math.log2(players)) + 1), 11);
  return Math.min(chosen || auto, Math.max(1, players - 1));
}

/** « 3,5 », « 1 », « ½ » */
export function fmtPoints(p: number): string {
  if (p === 0.5) return "½";
  return p % 1 ? `${Math.floor(p)},5` : String(p);
}

export interface SwissRow { userId: string; rating: number; rank: number; points: number; buchholz: number; sb: number; payoutCents: Cents; playing: boolean }

/** Classement suisse : rang final s'il est connu, sinon points, Buchholz, Sonneborn-Berger, tête de série. */
export function swissRows(s: SngSnapshot): SwissRow[] {
  const inGame = new Set(s.rounds.flat().filter((m) => m.status === "playing").flatMap((m) => [m.p1, m.p2]));
  const players = s.players.filter((p) => ACTIVE.includes(p.status));
  const sorted = [...players].sort((a, b) =>
    (a.finalRank ?? 0) - (b.finalRank ?? 0) || (b.points ?? 0) - (a.points ?? 0) || (b.buchholz ?? 0) - (a.buchholz ?? 0)
    || (b.sonnebornBerger ?? 0) - (a.sonnebornBerger ?? 0) || (a.seed ?? 999) - (b.seed ?? 999) || b.rating - a.rating);
  return sorted.map((p, i) => ({
    userId: p.userId, rating: p.rating, rank: p.finalRank ?? i + 1, points: p.points ?? 0, buchholz: p.buchholz ?? 0,
    sb: p.sonnebornBerger ?? 0, payoutCents: p.payoutCents, playing: inGame.has(p.userId),
  }));
}

/** Score d'un échiquier suisse : « 1-0 », « ½-½ », « exempt », « — ». */
export function swissBoardScore(m: SngMatchView): string {
  if (m.result === "bye") return "exempt (1 pt)";
  if (!m.result) return "—";
  const g = m.games.at(-1);
  if (g?.termination === "aborted") return `${m.result} (forfait)`;
  return m.result === "1/2-1/2" ? "½-½" : m.result;
}

/** Règles du suisse, en clair. */
export const SWISS_RULES = [
  "Système suisse : tout le monde joue toutes les rondes, personne n'est éliminé.",
  "Victoire 1 point, nulle ½, défaite 0. À chaque ronde, tu rencontres un joueur qui a le même nombre de points que toi, jamais deux fois le même.",
  "Les couleurs sont équilibrées (Blancs et Noirs en alternance). Nombre impair : un joueur est exempt et marque 1 point (une seule fois).",
  "Chaque ronde démarre toute seule quand toutes les parties de la précédente sont finies : 45 s pour jouer son premier coup, sinon la partie est perdue.",
  "Départage : Buchholz (points des adversaires rencontrés), puis Sonneborn-Berger, puis nombre de victoires.",
];
