import { Chess, type Square } from "chess.js";
import type { Color } from "@chessarena/shared";

export type PromotionPiece = "q" | "r" | "b" | "n";

export interface LocalMove {
  uci: string;
  fen: string;
  san: string;
}

/**
 * Pré-validation locale d'un coup (réactivité). Le serveur re-valide toujours ;
 * en cas de désaccord, son état fait foi (rollback dans le reducer).
 */
export function tryLocalMove(fen: string, from: string, to: string, promotion?: PromotionPiece): LocalMove | null {
  const c = new Chess(fen);
  try {
    const m = c.move({ from, to, promotion });
    if (promotion && !m.promotion) return null; // "e2e4q" : pièce de promotion superflue
    return { uci: from + to + (m.promotion ?? ""), fen: c.fen(), san: m.san };
  } catch {
    return null;
  }
}

/** Le déplacement from→to est-il une promotion (pion sur la dernière rangée) ? */
export function isPromotion(fen: string, from: string, to: string): boolean {
  const c = new Chess(fen);
  const p = c.get(from as Square);
  if (!p || p.type !== "p") return false;
  if (!((p.color === "w" && to[1] === "8") || (p.color === "b" && to[1] === "1"))) return false;
  return c.moves({ square: from as Square, verbose: true }).some((m) => m.to === to);
}

export function pieceColorAt(fen: string, square: string): Color | null {
  return new Chess(fen).get(square as Square)?.color ?? null;
}

export function legalTargets(fen: string, from: string): string[] {
  return new Chess(fen).moves({ square: from as Square, verbose: true }).map((m) => m.to);
}

export interface Premove {
  from: string;
  to: string;
  promotion?: PromotionPiece;
}

/**
 * Exécution d'un pré-move quand le trait revient au joueur : il doit être légal
 * dans la NOUVELLE position, sinon il est simplement abandonné (comme sur Lichess).
 */
export function resolvePremove(fen: string, pm: Premove): LocalMove | null {
  const promotion = pm.promotion ?? (isPromotion(fen, pm.from, pm.to) ? "q" : undefined);
  return tryLocalMove(fen, pm.from, pm.to, promotion);
}

export function uciToSquares(uci: string | null): [string, string] | null {
  return uci && uci.length >= 4 ? [uci.slice(0, 2), uci.slice(2, 4)] : null;
}
