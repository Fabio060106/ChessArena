import { Chess } from "chess.js";
import { formatScore, pvToSan, scoreToCp, winPct, type EngineLine, type Score } from "./engine";
import { buildReview, type GameReview } from "./gameReview";
import { openingOf } from "./openings";

/** Version du format (doit correspondre à REVIEW_VERSION côté serveur). */
export const TEACHING_VERSION = 2;

export type TeachMark = "!" | "?!" | "?" | "??" | "";

export interface TeachAlternative { san: string; eval: string; line: string }

export interface TeachMove {
  ply: number;
  san: string;
  mover: "w" | "b";
  mark: TeachMark;
  /** évaluation après le coup (point de vue des Blancs) */
  evalAfter: string;
  /** meilleur coup selon Stockfish à la place (null si c'est le coup joué) */
  best: string | null;
  /** autres coups possibles (2 au plus), avec leur évaluation et la suite */
  alternatives: TeachAlternative[];
  /** commentaire en français simple */
  comment: string;
  /** coup de la théorie d'ouverture */
  theory: boolean;
  /** quiz : coups acceptés comme bonne réponse (UCI), dans la position d'avant */
  goodUcis: string[];
}

export interface TeachingReview extends GameReview {
  version: typeof TEACHING_VERSION;
  opening: string | null;
  moves: TeachMove[];
  /** demi-coups proposés au quiz « trouve le meilleur coup » (erreurs et coups « ! ») */
  quiz: number[];
}

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const NAME: Record<string, string> = { p: "le pion", n: "le cavalier", b: "le fou", r: "la tour", q: "la dame", k: "le roi" };
const SIDE = { w: "les Blancs", b: "les Noirs" } as const;

/** Chances de gain (0–100) du joueur `c`. */
const winFor = (s: Score, c: "w" | "b") => { const w = winPct(scoreToCp(s)); return c === "w" ? w : 100 - w; };
const mateFor = (s: Score, c: "w" | "b"): number | null => (s.mate !== null && s.mate !== 0 && (s.mate > 0) === (c === "w") ? Math.abs(s.mate) : null);

function moveInfo(fen: string, uci: string): { san: string; captured: string | null; to: string; check: boolean } | null {
  try {
    const c = new Chess(fen);
    const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return { san: m.san, captured: m.captured ?? null, to: m.to, check: c.inCheck() };
  } catch { return null; }
}

/**
 * Analyse pédagogique d'une partie : un commentaire pour chaque coup, les meilleures alternatives,
 * une explication simple des erreurs (pièce laissée en prise, mat raté ou permis, prise manquée),
 * les coups « ! » (seul bon coup), l'ouverture jouée, et les positions du quiz.
 * `lines[i]` = meilleures suites (2 à 3) dans la position après i demi-coups.
 */
export function buildTeaching(p: {
  sans: readonly string[];
  ucis: readonly string[];
  fens: readonly string[];
  lines: ReadonlyArray<readonly EngineLine[]>;
  names: { w: string; b: string };
  result: string | null;
}): TeachingReview {
  const base = buildReview({
    sans: p.sans, fens: p.fens, names: p.names, result: p.result,
    evals: p.lines.map((ls) => ({ score: ls[0]!.score, pv: ls[0]!.pv })),
  });
  const opening = openingOf(p.sans);
  const moves: TeachMove[] = [];
  for (let ply = 1; ply <= p.sans.length && ply < p.lines.length; ply++) {
    const mover: "w" | "b" = ply % 2 === 1 ? "w" : "b";
    const before = p.lines[ply - 1]!; const after = p.lines[ply]!;
    const fenBefore = p.fens[ply - 1]!; const fenAfter = p.fens[ply]!;
    const played = p.ucis[ply - 1]!;
    const san = p.sans[ply - 1]!;
    const best = before[0]!;
    const bestUci = best.pv[0] ?? null;
    const isBest = bestUci === played;
    const loss = Math.max(0, winFor(best.score, mover) - winFor(after[0]!.score, mover));
    const bestInfo = bestUci ? moveInfo(fenBefore, bestUci) : null;
    const alternatives: TeachAlternative[] = before
      .filter((l) => l.pv[0] && l.pv[0] !== played)
      .slice(0, 2)
      .map((l) => ({ san: moveInfo(fenBefore, l.pv[0]!)?.san ?? l.pv[0]!, eval: formatScore(l.score), line: pvToSan(fenBefore, l.pv, 6).join(" ") }));
    const theory = ply <= opening.plies;
    let mark: TeachMark = loss >= 30 ? "??" : loss >= 20 ? "?" : loss >= 10 ? "?!" : "";
    const reasons: string[] = [];

    if (theory && !mark) {
      reasons.push(`Coup théorique : ${opening.name}.`);
    } else if (mark) {
      const allows = mateFor(after[0]!.score, mover === "w" ? "b" : "w");
      const missed = mateFor(best.score, mover);
      // pièce laissée en prise : une des meilleures réponses de l'adversaire (presque aussi forte que la meilleure) la prend
      const opp: "w" | "b" = mover === "w" ? "b" : "w";
      const top = winFor(after[0]!.score, opp);
      const reply = after
        .filter((l) => l.pv[0] && winFor(l.score, opp) >= top - 10)
        .map((l) => moveInfo(fenAfter, l.pv[0]!))
        .find((x) => x?.captured && VALUE[x.captured]! >= 1) ?? null;
      if (missed && !isBest) reasons.push(`Il y avait un mat en ${missed} : ${pvToSan(fenBefore, best.pv, Math.min(2 * missed - 1, 9)).join(" ")}.`);
      else if (allows) reasons.push(`Ce coup permet ${mover === "w" ? "aux Noirs" : "aux Blancs"} de mater en ${allows} : ${pvToSan(fenAfter, after[0]!.pv, Math.min(2 * allows - 1, 9)).join(" ")}.`);
      else if (reply?.captured && VALUE[reply.captured]! >= 1) reasons.push(`Ce coup laisse ${NAME[reply.captured]} en ${reply.to} sans protection suffisante : ${reply.san} le gagne.`);
      else if (bestInfo?.captured && VALUE[bestInfo.captured]! >= 3 && !moveInfo(fenBefore, played)?.captured) reasons.push(`Il fallait prendre ${NAME[bestInfo.captured]} en ${bestInfo.to} avec ${bestInfo.san}.`);
      else if (bestInfo) reasons.push(`${bestInfo.san} était plus fort (${formatScore(best.score)} au lieu de ${formatScore(after[0]!.score)}).`);
      const label = mark === "??" ? "Gaffe" : mark === "?" ? "Erreur" : "Imprécision";
      reasons.unshift(`${label} ${mover === "w" ? "des Blancs" : "des Noirs"}.`);
    } else if (isBest) {
      const second = before[1];
      const gap = second ? winFor(best.score, mover) - winFor(second.score, mover) : 0;
      if (second && gap >= 15 && ply > opening.plies) {
        mark = "!";
        const s2 = moveInfo(fenBefore, second.pv[0] ?? "")?.san;
        reasons.push(`Seul bon coup ! ${s2 ? `La deuxième meilleure option, ${s2}, ne valait que ${formatScore(second.score)}.` : ""}`.trim());
      } else {
        reasons.push(bestInfo?.check ? "Meilleur coup, avec échec." : bestInfo?.captured ? `Meilleur coup : prend ${NAME[bestInfo.captured]}.` : "Meilleur coup selon Stockfish.");
      }
    } else if (loss < 4) {
      reasons.push(`Bon coup.${bestInfo ? ` ${bestInfo.san} était aussi fort.` : ""}`);
    } else {
      reasons.push(`Coup correct, mais ${bestInfo?.san ?? "un autre coup"} était un peu plus précis (${formatScore(best.score)}).`);
    }
    // bonnes réponses au quiz : les coups qui gardent presque autant de chances que le meilleur
    const goodUcis = before.filter((l) => l.pv[0] && winFor(best.score, mover) - winFor(l.score, mover) < 5).map((l) => l.pv[0]!);
    moves.push({
      ply, san, mover, mark, evalAfter: formatScore(after[0]!.score),
      best: isBest ? null : bestInfo?.san ?? null, alternatives, comment: reasons.join(" "), theory,
      goodUcis: mark === "!" ? [played] : goodUcis.filter((u) => mark === "" || u !== played),
    });
  }
  // quiz : les plus grosses erreurs (moments clés, 4 au plus) et les « ! » (2 au plus), dans l'ordre de la partie
  const errs = base.moments.map((m) => m.ply).filter((x) => ["??", "?", "?!"].includes(moves[x - 1]?.mark ?? "")).slice(0, 4);
  const greats = moves.filter((m) => m.mark === "!").map((m) => m.ply).slice(0, 2);
  const quiz = [...new Set([...errs, ...greats])].sort((a, b) => a - b);
  const summary = opening.name ? `${opening.name}. ${base.summary}` : base.summary;
  return { ...base, version: TEACHING_VERSION, opening: opening.name, moves, quiz, summary };
}

/** Texte du quiz pour une position : qui joue, et ce qu'on cherche. */
export function quizPrompt(m: TeachMove, names: { w: string; b: string }): string {
  const who = `${names[m.mover]} (${SIDE[m.mover]})`;
  return m.mark === "!"
    ? `${who} a trouvé ici le seul bon coup. À toi : quel est-il ?`
    : `${who} s'est trompé ici. Trouve un meilleur coup que ${m.san}.`;
}
