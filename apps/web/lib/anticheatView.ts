import { Chess } from "chess.js";
import type { CaseGameView, Color, MoveAnalysis } from "@chessarena/shared";

/**
 * Transformations pures pour le back-office anti-triche (testées sans navigateur).
 */

/** Qualité d'un coup selon sa perte, mêmes paliers que les plateformes de référence. */
export type MoveGrade = "best" | "good" | "inaccuracy" | "mistake" | "blunder";

export function gradeMove(m: Pick<MoveAnalysis, "cpLoss" | "matched" | "included">): MoveGrade {
  if (m.matched) return "best";
  if (m.cpLoss >= 300) return "blunder";
  if (m.cpLoss >= 100) return "mistake";
  if (m.cpLoss >= 50) return "inaccuracy";
  return "good";
}

export const GRADE_LABEL: Record<MoveGrade, string> = {
  best: "★ coup moteur", good: "", inaccuracy: "?! imprécision", mistake: "? erreur", blunder: "?? gaffe",
};

/**
 * Éval (centipions, côté Blancs) → ordonnée dans [−1, 1], écrasée comme une
 * probabilité de gain : les écarts autour de 0 restent lisibles, un mat ne
 * fait pas exploser l'échelle.
 */
export function evalToUnit(cp: number): number {
  const c = Math.max(-2000, Math.min(2000, cp));
  return 2 / (1 + Math.exp(-0.004 * c)) - 1;
}

export function formatEval(cp: number, mate: number | null = null): string {
  if (mate !== null) return mate === 0 ? "#" : `${mate > 0 ? "" : "−"}M${Math.abs(mate)}`;
  if (Math.abs(cp) >= 9_000) return cp > 0 ? "+M" : "−M";
  const p = cp / 100;
  return `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p).toFixed(2)}`;
}

export function formatMs(ms: number): string {
  return ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`;
}

/** Numéro de coup lisible : ply 0 → « 1. », ply 1 → « 1… » */
export function moveNumber(ply: number): string {
  return `${Math.floor(ply / 2) + 1}${ply % 2 === 0 ? "." : "…"}`;
}

/** FEN après chaque demi-coup (index 0 = position initiale), pour le plateau. */
export function fensFromPgn(pgn: string): string[] {
  const src = new Chess();
  try {
    src.loadPgn(pgn);
  } catch {
    return [new Chess().fen()];
  }
  const board = new Chess();
  const out = [board.fen()];
  for (const m of src.history()) {
    board.move(m);
    out.push(board.fen());
  }
  return out;
}

/** Synthèse par couleur d'une partie, pour les tuiles de chiffres clés. */
export function suspectSummary(g: CaseGameView) {
  const mine = g.moves.filter((m) => m.color === g.color && m.included);
  const grades = mine.map(gradeMove);
  return {
    analysed: mine.length,
    best: grades.filter((x) => x === "best").length,
    blunders: grades.filter((x) => x === "blunder").length,
    mistakes: grades.filter((x) => x === "mistake").length,
    longestMatchStreak: longestStreak(mine.map((m) => m.matched)),
  };
}

export function longestStreak(flags: boolean[]): number {
  let best = 0;
  let cur = 0;
  for (const f of flags) {
    cur = f ? cur + 1 : 0;
    best = Math.max(best, cur);
  }
  return best;
}

export const colorName = (c: Color) => (c === "w" ? "Blancs" : "Noirs");

export function formatCents(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency === "EUR" ? "€" : "jetons"}`;
}
