/**
 * Système suisse — appariements et classement (fonctions pures, testées).
 *
 * APPARIEMENTS (inspirés du système hollandais de la FIDE, simplifiés)
 *   • Joueurs triés par points, puis tête de série (Elo au départ).
 *   • Nombre impair : exempt (1 point) pour le moins bien classé qui ne l'a pas encore été.
 *   • Dans un groupe de points, la moitié haute rencontre la moitié basse (1 contre 5, 2 contre 6… sur 8) ;
 *     un joueur qui ne trouve pas d'adversaire dans son groupe « flotte » vers le groupe suivant.
 *   • Jamais deux fois le même adversaire ; pas trois fois de suite la même couleur, ni un écart de plus de 2.
 *     Si c'est impossible (fin de petit tournoi), la contrainte de couleur, puis celle de la rencontre, sont relâchées.
 *   • Couleurs : celui qui a eu le moins les Blancs les prend ; à égalité, alternance ; sinon le mieux classé
 *     reçoit la couleur qui lui revient (première ronde : tirage pour l'échiquier 1, puis alternance).
 *
 * CLASSEMENT : points, puis Buchholz (somme des points des adversaires), Sonneborn-Berger, victoires, tête de série.
 */

export interface SwissPlayer {
  id: string;
  /** tête de série (1 = Elo le plus haut au départ) */
  seed: number;
  /** points × 2 (une nulle = 1), pour rester en entiers */
  pts2: number;
  opponents: string[];
  /** couleurs jouées, dans l'ordre ("-" = exempt) */
  colors: Array<"w" | "b" | "-">;
  hadBye: boolean;
}

export interface SwissPairing {
  /** [Blancs, Noirs] par échiquier, échiquier 1 en tête */
  boards: Array<[string, string]>;
  bye: string | null;
}

const colorDiff = (p: SwissPlayer) => p.colors.reduce((d, c) => d + (c === "w" ? 1 : c === "b" ? -1 : 0), 0);
const played = (p: SwissPlayer) => p.colors.filter((c) => c !== "-") as Array<"w" | "b">;

/** Couleur que le joueur ne peut plus recevoir (trois fois de suite ou écart > 2), sinon null. */
function forbiddenColor(p: SwissPlayer): "w" | "b" | null {
  const c = played(p);
  const d = colorDiff(p);
  if (d >= 2 || (c.length >= 2 && c.at(-1) === "w" && c.at(-2) === "w")) return "w";
  if (d <= -2 || (c.length >= 2 && c.at(-1) === "b" && c.at(-2) === "b")) return "b";
  return null;
}

/** Qui prend les Blancs entre a (mieux classé) et b ; null si les couleurs sont incompatibles. */
export function colorsFor(a: SwissPlayer, b: SwissPlayer, firstRoundWhite: boolean): [string, string] | null {
  const can = (w: SwissPlayer, bl: SwissPlayer) => forbiddenColor(w) !== "w" && forbiddenColor(bl) !== "b";
  let aWhite: boolean;
  const da = colorDiff(a), db = colorDiff(b);
  if (!played(a).length && !played(b).length) aWhite = firstRoundWhite;
  else if (da !== db) aWhite = da < db;
  else {
    const la = played(a).at(-1), lb = played(b).at(-1);
    if (la && lb && la !== lb) aWhite = la === "b";
    else aWhite = la ? la === "b" : lb ? lb === "w" : firstRoundWhite; // le mieux classé reçoit sa couleur due
  }
  if (aWhite && can(a, b)) return [a.id, b.id];
  if (!aWhite && can(b, a)) return [b.id, a.id];
  return null;
}

/** Classement courant : points, puis tête de série. */
const byScore = (a: SwissPlayer, b: SwissPlayer) => b.pts2 - a.pts2 || a.seed - b.seed;

/**
 * Appariement d'une ronde. `random` sert au tirage de la couleur de l'échiquier 1.
 * Recherche avec retour arrière (bornée) : la première solution trouvée respecte l'ordre de préférence.
 */
export function pairRound(players: readonly SwissPlayer[], random: () => number = Math.random): SwissPairing {
  const sorted = [...players].sort(byScore);
  let bye: string | null = null;
  let pool = sorted;
  const topWhite = random() < 0.5;
  for (const level of [0, 1, 2] as const) {
    // niveau 0 : toutes les règles ; 1 : couleurs relâchées ; 2 : rencontres répétées permises
    const byeCandidates = sorted.length % 2 === 1
      ? [...sorted].reverse().filter((p) => !p.hadBye).concat(level === 2 ? [...sorted].reverse().filter((p) => p.hadBye) : [])
      : [null];
    for (const b of byeCandidates) {
      pool = b ? sorted.filter((p) => p.id !== b.id) : sorted;
      const res = search(pool, level, topWhite);
      if (res) { bye = b?.id ?? null; return { boards: res, bye }; }
    }
  }
  // impossible en pratique (niveau 2 accepte tout) : appariement dans l'ordre
  const boards: Array<[string, string]> = [];
  for (let i = 0; i + 1 < pool.length; i += 2) boards.push([pool[i]!.id, pool[i + 1]!.id]);
  return { boards, bye };
}

function search(pool: SwissPlayer[], level: 0 | 1 | 2, topWhite: boolean): Array<[string, string]> | null {
  let budget = 20_000; // nombre de nœuds explorés au plus
  const out: Array<[string, string]> = [];
  const used = new Set<string>();
  const rec = (): boolean => {
    if (--budget < 0) return false;
    const rest = pool.filter((p) => !used.has(p.id));
    if (!rest.length) return true;
    const p = rest[0]!;
    // groupe de points de p (joueurs restants à égalité de points) : la moitié haute contre la moitié basse
    const group = rest.filter((q) => q.pts2 === p.pts2);
    const ideal = Math.floor(group.length / 2);
    const cands = rest.slice(1).map((q) => {
      const gi = group.indexOf(q);
      // même groupe : distance à l'adversaire idéal ; groupes inférieurs : ensuite, les plus proches en points d'abord
      const cost = gi >= 0 ? Math.abs(gi - ideal) : 1000 + (p.pts2 - q.pts2) * 100 + rest.indexOf(q);
      return { q, cost };
    }).sort((x, y) => x.cost - y.cost);
    for (const { q } of cands) {
      if (level < 2 && p.opponents.includes(q.id)) continue;
      const board = out.length;
      const firstWhite = board % 2 === 0 ? topWhite : !topWhite;
      let colors = colorsFor(p, q, firstWhite);
      if (!colors) {
        if (level === 0) continue;
        colors = (colorDiff(p) <= colorDiff(q)) ? [p.id, q.id] : [q.id, p.id];
      }
      used.add(p.id); used.add(q.id); out.push(colors);
      if (rec()) return true;
      used.delete(p.id); used.delete(q.id); out.pop();
    }
    return false;
  };
  return rec() ? out : null;
}

export interface SwissResult { white: string; black: string; /** points × 2 des Blancs : 2, 1 ou 0 */ w2: number }

export interface SwissStanding { id: string; seed: number; pts2: number; buchholz2: number; sb4: number; wins: number; rank: number }

/**
 * Classement avec départages. `results` : toutes les parties jouées ; `byes` : exemptés (1 point chacun).
 * Buchholz en points × 2, Sonneborn-Berger en points × 4 (entiers).
 */
export function swissStandings(players: ReadonlyArray<{ id: string; seed: number }>, results: readonly SwissResult[], byes: readonly string[]): SwissStanding[] {
  const pts = new Map(players.map((p) => [p.id, 0]));
  const wins = new Map(players.map((p) => [p.id, 0]));
  for (const r of results) {
    pts.set(r.white, (pts.get(r.white) ?? 0) + r.w2);
    pts.set(r.black, (pts.get(r.black) ?? 0) + 2 - r.w2);
    if (r.w2 === 2) wins.set(r.white, (wins.get(r.white) ?? 0) + 1);
    if (r.w2 === 0) wins.set(r.black, (wins.get(r.black) ?? 0) + 1);
  }
  for (const b of byes) pts.set(b, (pts.get(b) ?? 0) + 2);
  const bh = new Map(players.map((p) => [p.id, 0]));
  const sb = new Map(players.map((p) => [p.id, 0]));
  for (const r of results) {
    const pw = pts.get(r.white) ?? 0, pb = pts.get(r.black) ?? 0;
    bh.set(r.white, bh.get(r.white)! + pb);
    bh.set(r.black, bh.get(r.black)! + pw);
    sb.set(r.white, sb.get(r.white)! + pb * r.w2);
    sb.set(r.black, sb.get(r.black)! + pw * (2 - r.w2));
  }
  const rows = players.map((p) => ({ id: p.id, seed: p.seed, pts2: pts.get(p.id)!, buchholz2: bh.get(p.id)!, sb4: sb.get(p.id)!, wins: wins.get(p.id)!, rank: 0 }));
  rows.sort((a, b) => b.pts2 - a.pts2 || b.buchholz2 - a.buchholz2 || b.sb4 - a.sb4 || b.wins - a.wins || a.seed - b.seed);
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

/** Nombre de rondes conseillé : de quoi départager (log2 du nombre de joueurs, arrondi au-dessus, +1), plafonné. */
export function defaultSwissRounds(players: number): number {
  if (players <= 2) return 1;
  return Math.min(players - 1, Math.max(3, Math.ceil(Math.log2(players)) + 1), 11);
}
