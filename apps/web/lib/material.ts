import type { Color } from "@chessarena/shared";

/**
 * Pièces prises et avantage matériel, calculés depuis la FEN (comme Lichess / Chess.com).
 * Valeurs : pion 1, cavalier 3, fou 3, tour 5, dame 9.
 */
type Kind = "p" | "n" | "b" | "r" | "q";
const START: Record<Kind, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const VALUE: Record<Kind, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const ORDER: Kind[] = ["q", "r", "b", "n", "p"];
const GLYPH: Record<Kind, string> = { q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };

export interface MaterialSide {
  /** pièces adverses prises par ce camp, de la plus forte à la plus faible (ex. "♜♟♟") */
  captured: string;
  /** avance matérielle en points (0 si égalité ou retard) */
  plus: number;
}

export function material(fen: string): Record<Color, MaterialSide> {
  const count: Record<Color, Record<Kind, number>> = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const ch of fen.split(" ")[0] ?? "") {
    const k = ch.toLowerCase() as Kind;
    if (!(k in VALUE)) continue;
    count[ch === ch.toUpperCase() ? "w" : "b"][k]++;
  }
  const score = (c: Color) => ORDER.reduce((s, k) => s + count[c][k] * VALUE[k], 0);
  // pièces prises par `c` = pièces manquantes de l'adversaire (une promotion peut rendre le compte négatif : borné à 0)
  const captured = (c: Color) => {
    const opp: Color = c === "w" ? "b" : "w";
    return ORDER.map((k) => GLYPH[k].repeat(Math.max(0, START[k] - count[opp][k]))).join("");
  };
  const diff = score("w") - score("b");
  return {
    w: { captured: captured("w"), plus: Math.max(0, diff) },
    b: { captured: captured("b"), plus: Math.max(0, -diff) },
  };
}
