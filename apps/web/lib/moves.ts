import { Chess, type Square } from "chess.js";
import type { Color } from "@chessarena/shared";

/**
 * Logique de coups côté client — pure, sans React, testée.
 *
 *  - pré-validation locale d'un coup (réactivité ; le serveur re-valide toujours) ;
 *  - file de pré-moves ILLIMITÉE : chaque pré-move est vérifié géométriquement sur la
 *    position « virtuelle » (position serveur + pré-moves déjà en file), puis exécuté
 *    dès que le trait revient, le premier de la file d'abord. Un pré-move devenu illégal
 *    vide toute la file (comportement des plateformes de référence : la suite n'a plus de sens) ;
 *  - modèle du plateau pour l'affichage (position → sprites stables, pour animer les pièces).
 */

export type PromotionPiece = "q" | "r" | "b" | "n";
export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";
/** "wq" = dame blanche */
export type PieceCode = `${Color}${PieceType}`;
/** case → pièce */
export type BoardMap = Map<string, PieceCode>;

export interface LocalMove {
  uci: string;
  fen: string;
  san: string;
  captured: boolean;
  check: boolean;
  castle: boolean;
}

export interface Premove {
  from: string;
  to: string;
  promotion?: PromotionPiece;
}

export const FILES = "abcdefgh";

/** Pré-validation locale d'un coup. */
export function tryLocalMove(fen: string, from: string, to: string, promotion?: PromotionPiece): LocalMove | null {
  const c = new Chess(fen);
  try {
    const m = c.move({ from, to, promotion });
    if (promotion && !m.promotion) return null; // "e2e4q" : pièce de promotion superflue
    return { uci: from + to + (m.promotion ?? ""), fen: c.fen(), san: m.san, captured: !!m.captured, check: c.inCheck(),
      castle: m.flags.includes("k") || m.flags.includes("q") };
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

/** Case du roi en échec dans `fen` (camp au trait), sinon null. */
export function checkedKing(fen: string): string | null {
  const c = new Chess(fen);
  if (!c.inCheck()) return null;
  const turn = c.turn();
  for (const row of c.board()) for (const sq of row) if (sq && sq.type === "k" && sq.color === turn) return sq.square;
  return null;
}

export function uciToSquares(uci: string | null): [string, string] | null {
  return uci && uci.length >= 4 ? [uci.slice(0, 2), uci.slice(2, 4)] : null;
}

// ─── Plateau abstrait (géométrie, sans règles) ──────────────────────────────

export function boardFromFen(fen: string): BoardMap {
  const b: BoardMap = new Map();
  const rows = fen.split(" ")[0]!.split("/");
  rows.forEach((row, i) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { f += Number(ch); continue; }
      const color: Color = ch === ch.toUpperCase() ? "w" : "b";
      b.set(`${FILES[f]}${8 - i}`, `${color}${ch.toLowerCase()}` as PieceCode);
      f++;
    }
  });
  return b;
}

const fileOf = (sq: string) => FILES.indexOf(sq[0]!);
const rankOf = (sq: string) => Number(sq[1]) - 1;
const sq = (f: number, r: number) => (f >= 0 && f < 8 && r >= 0 && r < 8 ? `${FILES[f]}${r + 1}` : null);

/**
 * Applique un déplacement SANS vérifier la légalité (affichage des pré-moves) :
 * roque (le roi se déplace de 2 colonnes → la tour suit), prise en passant
 * (pion en diagonale vers une case vide → le pion pris disparaît), promotion.
 */
export function applyRawMove(board: BoardMap, from: string, to: string, promotion: PromotionPiece = "q"): BoardMap {
  const next = new Map(board);
  const piece = next.get(from);
  if (!piece) return next;
  next.delete(from);
  const color = piece[0] as Color;
  const type = piece[1] as PieceType;
  if (type === "k" && Math.abs(fileOf(to) - fileOf(from)) === 2) {
    const r = rankOf(from);
    const [rookFrom, rookTo] = fileOf(to) > fileOf(from) ? [sq(7, r)!, sq(5, r)!] : [sq(0, r)!, sq(3, r)!];
    const rook = next.get(rookFrom);
    if (rook) { next.delete(rookFrom); next.set(rookTo, rook); }
  }
  if (type === "p" && fileOf(to) !== fileOf(from) && !next.has(to)) {
    next.delete(sq(fileOf(to), rankOf(from))!); // en passant
  }
  const lastRank = color === "w" ? 7 : 0;
  next.set(to, type === "p" && rankOf(to) === lastRank ? (`${color}${promotion}` as PieceCode) : piece);
  return next;
}

/**
 * Destinations possibles d'un PRÉ-move (géométrie seule, comme chessground) :
 * les pièces peuvent bouger d'ici à l'exécution, donc on ignore obstacles et occupation.
 * La légalité réelle est vérifiée au moment de jouer (`resolvePremove`).
 */
export function premoveDests(board: BoardMap, from: string): string[] {
  const piece = board.get(from);
  if (!piece) return [];
  const color = piece[0] as Color;
  const type = piece[1] as PieceType;
  const f = fileOf(from);
  const r = rankOf(from);
  const out = new Set<string>();
  const add = (ff: number, rr: number) => { const s = sq(ff, rr); if (s) out.add(s); };
  const ray = (df: number, dr: number) => { for (let i = 1; i < 8; i++) add(f + df * i, r + dr * i); };
  switch (type) {
    case "p": {
      const dir = color === "w" ? 1 : -1;
      add(f, r + dir);
      if (r === (color === "w" ? 1 : 6)) add(f, r + 2 * dir);
      add(f - 1, r + dir);
      add(f + 1, r + dir);
      break;
    }
    case "n":
      for (const [df, dr] of [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]] as const) add(f + df, r + dr);
      break;
    case "b": ray(1, 1); ray(1, -1); ray(-1, 1); ray(-1, -1); break;
    case "r": ray(1, 0); ray(-1, 0); ray(0, 1); ray(0, -1); break;
    case "q": ray(1, 1); ray(1, -1); ray(-1, 1); ray(-1, -1); ray(1, 0); ray(-1, 0); ray(0, 1); ray(0, -1); break;
    case "k": {
      for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) if (df || dr) add(f + df, r + dr);
      const home = color === "w" ? 0 : 7;
      if (f === 4 && r === home) {
        if (board.get(sq(7, home)!) === `${color}r`) add(6, home);
        if (board.get(sq(0, home)!) === `${color}r`) add(2, home);
      }
      break;
    }
  }
  return [...out];
}

/** Position affichée pendant que des pré-moves sont en file. */
export function virtualBoard(fen: string, queue: readonly Premove[]): BoardMap {
  return queue.reduce((b, pm) => applyRawMove(b, pm.from, pm.to, pm.promotion), boardFromFen(fen));
}

/**
 * Ajoute un pré-move à la file s'il est géométriquement possible sur la position virtuelle
 * et concerne une pièce du joueur. Retourne la nouvelle file, ou null si refusé.
 */
export function enqueuePremove(fen: string, queue: readonly Premove[], pm: Premove, myColor: Color): Premove[] | null {
  if (pm.from === pm.to) return null;
  const board = virtualBoard(fen, queue);
  const piece = board.get(pm.from);
  if (!piece || piece[0] !== myColor) return null;
  if (!premoveDests(board, pm.from).includes(pm.to)) return null;
  return [...queue, pm];
}

/**
 * Exécution d'un pré-move quand le trait revient : il doit être légal dans la NOUVELLE
 * position, sinon il est abandonné. Promotion : dame par défaut.
 */
export function resolvePremove(fen: string, pm: Premove): LocalMove | null {
  const promotion = pm.promotion ?? (isPromotion(fen, pm.from, pm.to) ? "q" : undefined);
  return tryLocalMove(fen, pm.from, pm.to, promotion);
}

/** Tête de file : le coup à jouer maintenant et la file restante (vide si illégal). */
export function takeNextPremove(fen: string, queue: readonly Premove[]): { move: LocalMove | null; rest: Premove[] } {
  const [head, ...rest] = queue;
  if (!head) return { move: null, rest: [] };
  const move = resolvePremove(fen, head);
  return move ? { move, rest } : { move: null, rest: [] };
}

// ─── Sprites (identité stable des pièces pour l'animation) ──────────────────

export interface PieceSprite {
  id: string;
  code: PieceCode;
  square: string;
}

const dist = (a: string, b: string) => Math.hypot(fileOf(a) - fileOf(b), rankOf(a) - rankOf(b));

/**
 * Réconcilie les sprites affichés avec une nouvelle position, en conservant l'identité
 * des pièces qui ont bougé (une pièce = un élément DOM qui glisse via `transform`, jamais
 * démonté/remonté). Pièces immobiles conservées ; pièces déplacées appariées à la plus proche
 * case d'arrivée de même nature ; pièces prises retirées ; promotions = nouveau sprite.
 */
export function reconcileSprites(prev: readonly PieceSprite[], next: BoardMap, newId: () => string): PieceSprite[] {
  const out: PieceSprite[] = [];
  const leftover: PieceSprite[] = [];
  const claimed = new Set<string>();
  for (const s of prev) {
    if (next.get(s.square) === s.code && !claimed.has(s.square)) { out.push(s); claimed.add(s.square); }
    else leftover.push(s);
  }
  const appeared = [...next.entries()].filter(([square]) => !claimed.has(square));
  // apparier d'abord les paires les plus proches (un cavalier qui bouge ne « vole » pas l'identité d'un autre)
  const pairs: Array<{ s: PieceSprite; square: string; d: number }> = [];
  for (const s of leftover) for (const [square, code] of appeared) if (code === s.code) pairs.push({ s, square, d: dist(s.square, square) });
  pairs.sort((a, b) => a.d - b.d);
  const usedSprite = new Set<string>();
  for (const p of pairs) {
    if (usedSprite.has(p.s.id) || claimed.has(p.square)) continue;
    usedSprite.add(p.s.id);
    claimed.add(p.square);
    out.push({ ...p.s, square: p.square });
  }
  for (const [square, code] of appeared) if (!claimed.has(square)) out.push({ id: newId(), code, square });
  return out;
}

/** Coordonnées d'affichage (0..7) d'une case selon l'orientation. */
export function squareToXY(square: string, orientation: Color): { x: number; y: number } {
  const f = fileOf(square);
  const r = rankOf(square);
  return orientation === "w" ? { x: f, y: 7 - r } : { x: 7 - f, y: r };
}

export function xyToSquare(x: number, y: number, orientation: Color): string | null {
  if (x < 0 || x > 7 || y < 0 || y > 7) return null;
  return orientation === "w" ? sq(x, 7 - y) : sq(7 - x, y);
}
