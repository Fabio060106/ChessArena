import { Chess } from "chess.js";
import type { ReplayStep } from "./replay";

/**
 * Variante explorée pendant l'analyse d'après-partie : le joueur déplace lui-même les pièces
 * à partir d'une position de la partie (`base`) et le moteur évalue ses coups.
 */
export interface Variation { base: number; steps: ReplayStep[] }

/** Position affichée : `ply` dans la partie, ou `vply` coups dans la variante (0 = position de départ de la variante). */
export interface Cursor { ply: number; variation: Variation | null; vply: number }

export const atMain = (ply: number): Cursor => ({ ply, variation: null, vply: 0 });

/** Joue un coup légal depuis `fen` ; null s'il est illégal. */
export function applyMove(fen: string, from: string, to: string, promotion?: string): (ReplayStep & { captured: boolean; check: boolean; castle: boolean }) | null {
  const c = new Chess(fen);
  try {
    const m = c.move({ from, to, promotion });
    return {
      fen: c.fen(), san: m.san, uci: m.from + m.to + (m.promotion ?? ""),
      captured: !!m.captured, check: c.inCheck(), castle: m.san.startsWith("O-O"),
    };
  } catch {
    return null;
  }
}

/** Position actuellement affichée. */
export function currentStep(main: readonly ReplayStep[], cur: Cursor): ReplayStep {
  if (cur.variation && cur.vply > 0) return cur.variation.steps[cur.vply - 1]!;
  return main[cur.variation ? cur.variation.base : cur.ply]!;
}

/** Position d'où part le dernier coup affiché (pour juger ce coup). */
export function previousStep(main: readonly ReplayStep[], cur: Cursor): ReplayStep | null {
  if (cur.variation && cur.vply > 0) return cur.vply === 1 ? main[cur.variation.base]! : cur.variation.steps[cur.vply - 2]!;
  return cur.ply > 0 ? main[cur.ply - 1]! : null;
}

/**
 * Coup joué sur l'échiquier pendant l'analyse :
 *  - c'est le coup de la partie → on avance simplement dans la partie ;
 *  - c'est le coup suivant de la variante en cours → on avance dans la variante ;
 *  - sinon → nouvelle variante (ou la variante est coupée à cet endroit et prolongée).
 */
export function playOnBoard(main: readonly ReplayStep[], cur: Cursor, step: ReplayStep): Cursor {
  const v = cur.variation;
  if (!v) {
    if (main[cur.ply + 1]?.uci === step.uci) return atMain(cur.ply + 1);
    return { ply: cur.ply, variation: { base: cur.ply, steps: [step] }, vply: 1 };
  }
  if (cur.vply === 0 && main[v.base + 1]?.uci === step.uci) return atMain(v.base + 1);
  if (v.steps[cur.vply]?.uci === step.uci) return { ...cur, vply: cur.vply + 1 };
  return { ply: v.base, variation: { base: v.base, steps: [...v.steps.slice(0, cur.vply), step] }, vply: cur.vply + 1 };
}

/** Numérotation des coups d'une variante : « 12. Cf3 », « 12… e5 ». */
export function numbered(baseFen: string, sans: readonly (string | null)[]): string[] {
  const [, turn, , , , full] = baseFen.split(" ");
  let n = Number(full) || 1;
  let black = turn === "b";
  return sans.map((san, i) => {
    const pre = !black ? `${n}. ` : i === 0 ? `${n}… ` : "";
    if (black) n++;
    black = !black;
    return pre + (san ?? "");
  });
}
