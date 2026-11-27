/**
 * Arena — score et appariements (fonctions pures, testées).
 *
 * DÉROULEMENT : pendant une durée fixe, chaque joueur libre reçoit un adversaire dès que possible ; on enchaîne
 * autant de parties qu'on veut. Après l'heure de fin, plus de nouvel appariement : les parties en cours comptent.
 *
 * POINTS : victoire 2, nulle 1, défaite 0. Série : après deux victoires de suite, le joueur est « en feu » 🔥 :
 * ses victoires valent 4 et ses nulles 2, jusqu'à ce qu'il ne gagne pas. Une partie annulée parce qu'un joueur n'a pas
 * joué son premier coup : 0 pour lui (série perdue), rien pour l'autre (ni points, ni série cassée).
 *
 * APPARIEMENT : les joueurs libres, triés par score puis Elo, sont appariés avec leur voisin de classement ;
 * on évite de rejouer tout de suite son dernier adversaire quand il y a un autre choix.
 * COULEURS : celui qui a eu le moins les Blancs les prend ; à égalité, au hasard.
 */

export interface ArenaGame {
  white: string;
  black: string;
  /** « 1-0 », « 0-1 », « 1/2-1/2 », « forfeit-w » / « forfeit-b » (premier coup non joué), null = en cours ou annulée sans responsable */
  result: "1-0" | "0-1" | "1/2-1/2" | "forfeit-w" | "forfeit-b" | null;
}

export interface ArenaScore {
  id: string;
  score: number;
  /** une valeur par partie terminée, dans l'ordre : points marqués (4 et 2 = en feu) */
  sheet: number[];
  wins: number;
  games: number;
  /** deux victoires de suite ou plus : la prochaine victoire vaut double */
  fire: boolean;
}

/** Scores de tous les joueurs à partir des parties (dans l'ordre chronologique). */
export function arenaScores(ids: readonly string[], games: readonly ArenaGame[]): Map<string, ArenaScore> {
  const out = new Map<string, ArenaScore & { streak: number }>(ids.map((id) => [id, { id, score: 0, sheet: [], wins: 0, games: 0, fire: false, streak: 0 }]));
  const get = (id: string) => {
    let s = out.get(id);
    if (!s) { s = { id, score: 0, sheet: [], wins: 0, games: 0, fire: false, streak: 0 }; out.set(id, s); }
    return s;
  };
  const record = (s: ArenaScore & { streak: number }, outcome: 2 | 1 | 0) => {
    const onFire = s.streak >= 2;
    const pts = outcome === 2 ? (onFire ? 4 : 2) : outcome === 1 ? (onFire ? 2 : 1) : 0;
    s.score += pts; s.sheet.push(pts); s.games++;
    if (outcome === 2) { s.wins++; s.streak++; } else s.streak = 0;
    s.fire = s.streak >= 2;
  };
  for (const g of games) {
    if (!g.result) continue;
    const w = get(g.white), b = get(g.black);
    if (g.result === "forfeit-w" || g.result === "forfeit-b") {
      const culprit = g.result === "forfeit-w" ? w : b;
      culprit.sheet.push(0); culprit.games++; culprit.streak = 0; culprit.fire = false;
      continue;
    }
    record(w, g.result === "1-0" ? 2 : g.result === "0-1" ? 0 : 1);
    record(b, g.result === "0-1" ? 2 : g.result === "1-0" ? 0 : 1);
  }
  for (const s of out.values()) delete (s as { streak?: number }).streak;
  return out;
}

/** Classement : score, puis victoires, puis moins de parties jouées (efficacité), puis Elo. */
export function arenaRanking(scores: Map<string, ArenaScore>, ratings: Map<string, number>): string[] {
  return [...scores.values()]
    .sort((a, b) => b.score - a.score || b.wins - a.wins || a.games - b.games || (ratings.get(b.id) ?? 0) - (ratings.get(a.id) ?? 0) || a.id.localeCompare(b.id))
    .map((s) => s.id);
}

export interface ArenaWaiting { id: string; score: number; rating: number; lastOpponent: string | null; whites: number; blacks: number }

/** Appariement des joueurs libres : voisins de classement, sans rejouer son dernier adversaire si possible. */
export function arenaPairs(waiting: readonly ArenaWaiting[], random: () => number = Math.random): Array<[string, string]> {
  const pool = [...waiting].sort((a, b) => b.score - a.score || b.rating - a.rating || a.id.localeCompare(b.id));
  const out: Array<[string, string]> = [];
  while (pool.length >= 2) {
    const a = pool.shift()!;
    let j = pool.findIndex((b) => b.id !== a.lastOpponent && a.id !== b.lastOpponent);
    if (j < 0) {
      // seul choix : son dernier adversaire. On le rejoue seulement s'ils ne sont que deux à attendre.
      if (pool.length === 1 && waiting.length === 2) j = 0;
      else continue;
    }
    const b = pool.splice(j, 1)[0]!;
    const aWhite = a.whites - a.blacks !== b.whites - b.blacks ? a.whites - a.blacks < b.whites - b.blacks : random() < 0.5;
    out.push(aWhite ? [a.id, b.id] : [b.id, a.id]);
  }
  return out;
}

/** Durées proposées (minutes). */
export const ARENA_MINUTES = [20, 30, 45, 60, 90, 120] as const;
