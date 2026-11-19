import { accuracy, Engine, scoreToCp, terminalScore, type EngineLine } from "./engine";
import { replayFromPgn } from "./replay";

/**
 * Revue anti-triche d'une partie, faite dans le navigateur de l'organisateur (Stockfish 19).
 * Mêmes principes que les sites d'échecs : on ignore l'ouverture (théorie apprise) et les positions
 * déjà gagnées ou perdues, puis on mesure à quel point les coups du joueur ressemblent à ceux du moteur.
 * Ce sont des INDICES : une seule partie ne prouve rien, il faut comparer au niveau habituel du joueur.
 */
export const REVIEW_DEPTH = 12;
const OPENING_PLIES = 16;
const DECIDED_CP = 1000;

export interface CheatMetrics {
  /** coups retenus (hors ouverture et positions décidées) */
  counted: number;
  /** % de coups identiques au premier choix du moteur */
  matchPct: number | null;
  /** perte moyenne en centipions par coup */
  acpl: number | null;
  /** précision façon Lichess (0–100) sur toute la partie */
  accuracy: number | null;
  level: "normal" | "watch" | "suspect";
  summary: string;
}

/**
 * `evals[i]` : éval (centipions, point de vue des Blancs) de la position avant le demi-coup i ;
 * `best[i]` : premier choix du moteur dans cette position ; `played[i]` : coup joué (UCI).
 */
export function cheatMetrics(evals: number[], best: (string | null)[], played: string[], color: "w" | "b"): CheatMetrics {
  let counted = 0, matches = 0, loss = 0;
  for (let i = OPENING_PLIES; i < played.length; i++) {
    const mover = i % 2 === 0 ? "w" : "b";
    if (mover !== color) continue;
    const before = evals[i], after = evals[i + 1];
    if (before === undefined || after === undefined || Math.abs(before) >= DECIDED_CP) continue;
    counted++;
    if (best[i] && best[i] === played[i]) matches++;
    const sign = color === "w" ? 1 : -1;
    const clamp = (x: number) => Math.max(-DECIDED_CP, Math.min(DECIDED_CP, x));
    loss += Math.max(0, sign * (clamp(before) - clamp(after)));
  }
  const matchPct = counted ? Math.round((matches / counted) * 100) : null;
  const acpl = counted ? Math.round(loss / counted) : null;
  const acc = accuracy(evals, color);
  const level: CheatMetrics["level"] = counted < 12 || matchPct === null || acpl === null ? "normal"
    : matchPct >= 85 && acpl <= 15 ? "suspect"
    : matchPct >= 72 && acpl <= 25 ? "watch" : "normal";
  const summary = counted < 12
    ? "Trop peu de coups significatifs pour juger cette partie."
    : level === "suspect" ? "Très proche du moteur : à comparer avec les autres parties du joueur avant de décider."
    : level === "watch" ? "Jeu très précis : possible chez un bon joueur, à surveiller sur plusieurs parties."
    : "Rien d'anormal : précision humaine.";
  return { counted, matchPct, acpl, accuracy: acc, level, summary };
}

/** Analyse complète d'une partie (≈ 1 s par position) ; `onProgress` de 0 à 1. */
export async function reviewGame(pgn: string, color: "w" | "b", onProgress: (p: number) => void): Promise<CheatMetrics> {
  const steps = replayFromPgn(pgn);
  const engine = new Engine();
  try {
    const evals: number[] = [];
    const best: (string | null)[] = [];
    for (let i = 0; i < steps.length; i++) {
      const t = terminalScore(steps[i]!.fen);
      const line: EngineLine | null = t ? null : await engine.analyse(steps[i]!.fen, REVIEW_DEPTH);
      evals.push(t ? scoreToCp(t) : line ? scoreToCp(line.score) : evals.at(-1) ?? 0);
      best.push(line?.pv[0] ?? null);
      onProgress((i + 1) / steps.length);
    }
    return cheatMetrics(evals, best, steps.slice(1).map((s) => s.uci ?? ""), color);
  } finally {
    engine.terminate();
  }
}
