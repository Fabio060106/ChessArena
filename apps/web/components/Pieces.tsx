import { memo } from "react";
import type { Color } from "@chessarena/shared";
import type { PieceCode, PieceType } from "../lib/moves";

/**
 * Jeu de pièces ORIGINAL ChessArena (géométrique, lisible en petit, dessiné pour ce projet :
 * aucune licence tierce). viewBox 100×100 (cadré 90×90 à l'affichage). Les couleurs viennent des variables CSS du thème
 * (dégradés partagés définis une seule fois dans <PieceDefs/>).
 */

const BASE = "M24 90h52v-5a5 5 0 0 0-5-5H29a5 5 0 0 0-5 5z";

const SHAPES: Record<PieceType, { body: string[]; detail?: string[]; circles?: Array<[number, number, number]>; dots?: Array<[number, number, number]> }> = {
  p: {
    body: [BASE, "M33 80C35 67 42 57 44 51h12c2 6 9 16 11 29z", "M37 51a4 4 0 0 1 0-8h26a4 4 0 0 1 0 8z"],
    circles: [[50, 31, 12.5]],
  },
  r: {
    body: [BASE, "M32 80l3-28h30l3 28z", "M29 52a3 3 0 0 1-3-3V22h10v7h7v-7h14v7h7v-7h10v27a3 3 0 0 1-3 3z"],
    detail: ["M35 40h30"],
  },
  b: {
    body: [
      BASE,
      "M34 80c3-10 8-18 9-24h14c1 6 6 14 9 24z",
      "M37 57a4 4 0 0 1 0-8h26a4 4 0 0 1 0 8z",
      "M50 13c11 8 15 18 13 27-2 7-7 9-13 9s-11-2-13-9c-2-9 2-19 13-27z",
    ],
    detail: ["M56 24L46 35"],
    circles: [[50, 10, 4.5]],
  },
  n: {
    body: [
      BASE,
      "M30 80c0-10 4-17 10-24 3-4 2-8-1-9l-9 4c-4 2-8 0-9-4l-1-5c-1-3 1-6 3-8l15-15 2-9 6 7c11 1 22 8 26 21 3 11 3 27 1 42z",
    ],
    detail: ["M58 30c5 6 8 15 8 26"],
    dots: [[41, 30, 3.2]],
  },
  q: {
    body: [
      BASE,
      "M28 80L22 37l12 16 2-25 9 24 5-27 5 27 9-24 2 25 12-16-6 43z",
    ],
    detail: ["M30 70h40"],
    circles: [[22, 34, 5], [36, 25, 5], [50, 19, 5.5], [64, 25, 5], [78, 34, 5]],
  },
  k: {
    body: [
      BASE,
      "M30 80c0-13 5-22 8-28h24c3 6 8 15 8 28z",
      "M35 53a4 4 0 0 1 0-8h30a4 4 0 0 1 0 8z",
      "M39 45c0-8 5-13 11-13s11 5 11 13z",
      "M46 34V24h-7v-8h7V9h8v7h7v8h-7v10z",
    ],
    detail: ["M36 70h28"],
  },
};

/** Dégradés partagés : à monter UNE fois dans le plateau (les variables du thème s'y appliquent). */
export function PieceDefs() {
  return (
    <svg width="0" height="0" aria-hidden style={{ position: "absolute" }}>
      <defs>
        <linearGradient id="arena-pw" x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" style={{ stopColor: "var(--pw-0)" }} />
          <stop offset="1" style={{ stopColor: "var(--pw-1)" }} />
        </linearGradient>
        <linearGradient id="arena-pb" x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" style={{ stopColor: "var(--pb-0)" }} />
          <stop offset="1" style={{ stopColor: "var(--pb-1)" }} />
        </linearGradient>
      </defs>
    </svg>
  );
}

export const PieceSvg = memo(function PieceSvg({ code }: { code: PieceCode }) {
  const color = code[0] as Color;
  const shape = SHAPES[code[1] as PieceType];
  const fill = color === "w" ? "url(#arena-pw)" : "url(#arena-pb)";
  const stroke = color === "w" ? "var(--pw-stroke)" : "var(--pb-stroke)";
  const detail = color === "w" ? "var(--pw-detail)" : "var(--pb-detail)";
  return (
    <svg viewBox="5 4 90 90" width="100%" height="100%" aria-hidden focusable="false" style={{ display: "block", overflow: "visible" }}>
      <g fill={fill} stroke={stroke} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round">
        {shape.body.map((d, i) => <path key={i} d={d} />)}
        {shape.circles?.map(([cx, cy, r], i) => <circle key={`c${i}`} cx={cx} cy={cy} r={r} />)}
      </g>
      {shape.detail && (
        <g fill="none" stroke={detail} strokeWidth={3} strokeLinecap="round" opacity={0.85}>
          {shape.detail.map((d, i) => <path key={i} d={d} />)}
        </g>
      )}
      {shape.dots?.map(([cx, cy, r], i) => <circle key={`d${i}`} cx={cx} cy={cy} r={r} fill={detail} />)}
    </svg>
  );
});

export const PIECE_NAMES: Record<PieceType, string> = { p: "pion", n: "cavalier", b: "fou", r: "tour", q: "dame", k: "roi" };
