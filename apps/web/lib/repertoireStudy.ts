import { Chess } from "chess.js";
import type { RepertoireGame } from "@chessarena/shared";
import type { RepertoireDef } from "./repertoireBook";
import { epdOf } from "./openingBook";

/**
 * Outils d'étude d'un répertoire : l'arbre des coups, les exercices « trouve le coup du répertoire »,
 * la comparaison avec les parties du joueur (où il en sort, ce que jouent ses adversaires), le plan d'apprentissage.
 */

export interface RepNode {
  /** coups du répertoire depuis cette position (SAN → UCI), avec le nom des lignes qui les jouent */
  moves: Map<string, { uci: string; lines: string[] }>;
}

/** Arbre du répertoire : position (EPD) → coups prévus. */
export function buildTree(sections: readonly RepertoireDef[]): Map<string, RepNode> {
  const tree = new Map<string, RepNode>();
  for (const r of sections) for (const l of r.lines) {
    const c = new Chess();
    for (const san of l.moves.split(" ")) {
      const k = epdOf(c.fen());
      const node = tree.get(k) ?? { moves: new Map() };
      tree.set(k, node);
      const m = c.move(san);
      const e = node.moves.get(m.san) ?? { uci: m.from + m.to + (m.promotion ?? ""), lines: [] };
      if (!e.lines.includes(l.name)) e.lines.push(l.name);
      node.moves.set(m.san, e);
    }
  }
  return tree;
}

export interface Exercise { fen: string; ply: number; line: string; answers: string[]; answerSan: string; prompt: string; before: string }

/**
 * Exercices : dans chaque ligne, les positions où le joueur doit trouver le coup du répertoire
 * juste après que l'adversaire a choisi une sous-ligne (là où la mémoire compte), et un coup plus loin.
 */
export function buildExercises(rep: RepertoireDef, tree: Map<string, RepNode>, max = 14): Exercise[] {
  const out: Exercise[] = [];
  const seen = new Set<string>();
  for (const l of rep.lines) {
    const c = new Chess();
    const sans = l.moves.split(" ");
    let picked = 0;
    for (let i = 0; i < sans.length && picked < 2; i++) {
      const fen = c.fen();
      const mover = c.turn();
      const k = epdOf(fen);
      if (mover === rep.side && i >= 4 && !seen.has(k)) {
        // la position vient d'un choix de l'adversaire (plusieurs réponses adverses couvertes au coup d'avant), ou c'est le cœur de la ligne
        const branch = i >= 1 && (() => { const b = new Chess(); for (const s of sans.slice(0, i - 1)) b.move(s); return (tree.get(epdOf(b.fen()))?.moves.size ?? 0) >= 2; })();
        if (branch || (picked === 0 && i >= sans.length / 2)) {
          const node = tree.get(k)!;
          const answers = [...node.moves.values()].map((x) => x.uci);
          const m = c.moves({ verbose: true }).find((x) => x.san === sans[i]);
          seen.add(k);
          picked++;
          out.push({
            fen, ply: i + 1, line: l.name, answers, answerSan: m?.san ?? sans[i]!,
            before: sans.slice(0, i).map((s, j) => (j % 2 === 0 ? `${j / 2 + 1}.${s}` : s)).join(" "),
            prompt: `${l.name} — à ${rep.side === "w" ? "toi (Blancs)" : "toi (Noirs)"} de jouer le coup du répertoire.`,
          });
        }
      }
      c.move(sans[i]!);
    }
  }
  return out.slice(0, max);
}

export interface Deviation { epd: string; fen: string; before: string; played: string; expected: string[]; count: number; score: number }
export interface StudyReport {
  /** parties où le joueur a la bonne couleur et où la partie commence dans le répertoire */
  games: number;
  /** parties restées dans le répertoire jusqu'au bout de la ligne connue */
  followed: number;
  followedScore: number | null;
  /** le joueur quitte le répertoire (coup différent de celui prévu) */
  mine: Deviation[];
  mineScore: number | null;
  /** l'adversaire joue un coup que le répertoire ne couvre pas */
  theirs: Deviation[];
  /** parties de cette couleur jouées avec une autre ouverture */
  elsewhere: number;
}

const PTS = { win: 1, draw: 0.5, loss: 0 } as const;

/** Compare les parties du joueur au répertoire. */
export function compareGames(rep: RepertoireDef, tree: Map<string, RepNode>, games: readonly RepertoireGame[]): StudyReport {
  const mine = new Map<string, Deviation & { pts: number }>();
  const theirs = new Map<string, Deviation & { pts: number }>();
  let n = 0, followed = 0, fPts = 0, mPts = 0, mN = 0, elsewhere = 0;
  for (const g of games) {
    if (g.color !== rep.side) continue;
    const c = new Chess();
    try { c.loadPgn(g.pgn); } catch { continue; }
    const hist = c.history();
    const b = new Chess();
    let state: "in" | "mine" | "theirs" | "end" = "in";
    let i = 0;
    for (; i < hist.length; i++) {
      const k = epdOf(b.fen());
      const node = tree.get(k);
      if (!node) { state = "end"; break; }
      if (!node.moves.has(hist[i]!)) {
        const who = b.turn() === rep.side ? "mine" : "theirs";
        if (i <= 1 && who === "mine") { state = "end"; elsewhere++; i = 0; break; }
        // premier coup blanc d'une autre famille (1.d4 contre un répertoire 1…c6) : la partie ne concerne pas ce répertoire
        if (i === 0 && who === "theirs") { state = "end"; break; }
        state = who;
        const map = who === "mine" ? mine : theirs;
        const before = hist.slice(0, i).map((s, j) => (j % 2 === 0 ? `${j / 2 + 1}.${s}` : s)).join(" ");
        const key = `${k}|${hist[i]}`;
        const d = map.get(key) ?? { epd: k, fen: b.fen(), before, played: hist[i]!, expected: [...node.moves.keys()], count: 0, score: 0, pts: 0 };
        d.count++; d.pts += PTS[g.outcome];
        map.set(key, d);
        break;
      }
      b.move(hist[i]!);
    }
    if (i === 0 && state === "end") continue;
    if (state === "in" && i >= hist.length) state = "end";
    n++;
    if (state === "end" || state === "in") { followed++; fPts += PTS[g.outcome]; }
    if (state === "mine") { mN++; mPts += PTS[g.outcome]; }
  }
  const fin = (m: Map<string, Deviation & { pts: number }>) => [...m.values()].map(({ pts, ...d }) => ({ ...d, score: Math.round((100 * pts) / d.count) })).sort((a, b) => b.count - a.count).slice(0, 8);
  return {
    games: n, followed, followedScore: followed ? Math.round((100 * fPts) / followed) : null,
    mine: fin(mine), mineScore: mN ? Math.round((100 * mPts) / mN) : null, theirs: fin(theirs), elsewhere,
  };
}

/** Plan d'apprentissage en étapes, selon que l'ouverture est à garder (déjà jouée) ou nouvelle. */
export function learningPlan(rep: RepertoireDef, mode: "keep" | "new", study: StudyReport | null, extraLines: number): Array<{ title: string; text: string }> {
  const lines = rep.lines.length;
  const steps: Array<{ title: string; text: string }> = [];
  if (mode === "new") {
    steps.push({ title: "1. Comprendre avant de mémoriser", text: `Lis l'onglet « Cours » : les structures de pions, les plans des deux camps et les erreurs typiques. Rejoue les positions sur l'échiquier ; c'est ce qui te fera retenir les coups.` });
    steps.push({ title: "2. Les lignes principales", text: `Apprends d'abord les ${Math.min(3, lines)} premières lignes de l'onglet « Lignes », une par jour : rejoue-les jusqu'à pouvoir les dire sans regarder, en expliquant chaque coup.` });
    steps.push({ title: "3. Les exercices", text: "Fais les exercices jusqu'à les réussir tous du premier coup. Refais-les deux jours plus tard : la répétition espacée fixe la mémoire." });
    steps.push({ title: "4. Les pièges", text: "Connais par cœur les pièges du cours : c'est là qu'on gagne (ou qu'on perd) des parties rapides." });
    steps.push({ title: "5. Jouer et vérifier", text: "Joue 10 parties en rapide (10 minutes ou plus) avec cette ouverture, puis reviens ici : l'onglet « Mes parties » te montrera où tu es sorti du répertoire." });
    if (extraLines) steps.push({ title: "6. Les compléments", text: `Termine par les ${extraLines} lignes complémentaires (réponses aux autres coups de l'adversaire) : tu auras alors un répertoire complet.` });
  } else {
    steps.push({ title: "1. Tes trous de mémoire", text: study && study.mine.length ? `Commence par les positions où tu quittes le répertoire (onglet « Mes parties ») : ${study.mine.slice(0, 3).map((d) => `après ${d.before || "le début"}, tu joues ${d.played} au lieu de ${d.expected.join(" ou ")}`).join(" ; ")}.` : "Vérifie dans l'onglet « Mes parties » que tes coups suivent bien le répertoire." });
    steps.push({ title: "2. Ce que jouent tes adversaires", text: study && study.theirs.length ? `Tes adversaires sortent souvent des lignes principales : ${study.theirs.slice(0, 3).map((d) => `${d.played} après ${d.before || "le début"} (${d.count} fois)`).join(" ; ")}. Prépare une réponse : ouvre la position sur l'échiquier d'analyse et note le meilleur plan.` : "Repère les coups adverses inhabituels que tu rencontres et prépare une réponse." });
    steps.push({ title: "3. Approfondir", text: `Passe en revue toutes les lignes (${lines}) et leurs idées ; puis les structures et plans de l'onglet « Cours » : c'est ce qui fait la différence une fois la théorie terminée.` });
    steps.push({ title: "4. Exercices et pièges", text: "Refais les exercices et révise les pièges une fois par semaine." });
  }
  return steps;
}
