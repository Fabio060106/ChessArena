import { memo } from "react";
import type { Color } from "@chessarena/shared";
import type { PieceCode, PieceType } from "../lib/moves";
import type { PieceSetId } from "../lib/boardThemes";

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
        {/* reflet (jeux Relief et Cristal) */}
        <linearGradient id="arena-gloss" x1="0" y1="0" x2="0.8" y2="0.9">
          <stop offset="0" stopColor="#fff" stopOpacity="0.85" />
          <stop offset="0.45" stopColor="#fff" stopOpacity="0.12" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        {/* trait tremblé (jeu Croquis) */}
        <filter id="arena-sketch" x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.07" numOctaves="3" seed="7" />
          <feDisplacementMap in="SourceGraphic" scale="6" />
        </filter>
        {/* ombrage cylindrique : une pièce tournée au tour, éclairée de la gauche (jeu Tourné, Bois, Marbre) */}
        <linearGradient id="arena-turn" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#000" stopOpacity="0.38" />
          <stop offset="0.22" stopColor="#fff" stopOpacity="0.42" />
          <stop offset="0.42" stopColor="#fff" stopOpacity="0.05" />
          <stop offset="0.75" stopColor="#000" stopOpacity="0.12" />
          <stop offset="1" stopColor="#000" stopOpacity="0.5" />
        </linearGradient>
        {/* veines du bois (allongées verticalement) */}
        <filter id="arena-wood" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.22 0.018" numOctaves="3" seed="11" result="n" />
          <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.22  0 0 0 0 0.11  0 0 0 0 0.03  1.5 0 0 0 -0.62" result="grain" />
          <feComposite in="grain" in2="SourceGraphic" operator="in" result="g" />
          <feMerge><feMergeNode in="SourceGraphic" /><feMergeNode in="g" /></feMerge>
        </filter>
        {/* veines du marbre */}
        <filter id="arena-marble" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="turbulence" baseFrequency="0.035" numOctaves="4" seed="4" result="n" />
          <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.35  0 0 0 0 0.36  0 0 0 0 0.4  -2.2 0 0 0 0.62" result="veins" />
          <feComposite in="veins" in2="SourceGraphic" operator="in" result="v" />
          <feMerge><feMergeNode in="SourceGraphic" /><feMergeNode in="v" /></feMerge>
        </filter>
        {/* ombre portée douce */}
        <filter id="arena-shadow" x="-20%" y="-20%" width="140%" height="150%">
          <feDropShadow dx="0" dy="2" stdDeviation="1.6" floodColor="#000" floodOpacity="0.45" />
        </filter>
      </defs>
    </svg>
  );
}

type Shape = { body: string[]; detail?: string[]; circles?: Array<[number, number, number]>; dots?: Array<[number, number, number]>; ellipses?: Array<[number, number, number, number]> };

/** Jeu « Classique » : silhouettes de type Staunton, avec socle à deux étages (dessin original). */
const PLINTH = ["M22 89h56v-5c0-3-2-5-5-5H27c-3 0-5 2-5 5z", "M27 79h46l-4-7H31z"];
const CLASSIC: Record<PieceType, Shape> = {
  p: { body: [...PLINTH, "M36 72c2-8 7-14 9-21h10c2 7 7 13 9 21z"], ellipses: [[50, 50, 12, 3.6]], circles: [[50, 36, 11]] },
  r: {
    body: [...PLINTH, "M34 72l3-29h26l3 29z", "M30 43V21h8v6h7v-6h10v6h7v-6h8v22z"],
    ellipses: [[50, 43, 18, 3.4]], detail: ["M38 56h24"],
  },
  b: {
    body: [...PLINTH, "M37 72c2-7 6-12 8-18h10c2 6 6 11 8 18z", "M50 15c10 7 14 16 12 25-1 6-6 10-12 10s-11-4-12-10c-2-9 2-18 12-25z"],
    ellipses: [[50, 52, 13, 3.4]], circles: [[50, 12, 4]], detail: ["M55 25l-8 10"],
  },
  n: {
    body: [...PLINTH, "M31 72c1-9 5-15 11-20 4-3 4-7 1-8-4 2-8 4-12 3-3-1-5-4-4-7 1-4 6-9 11-14 3-3 4-7 5-10l4 5c4-1 8-1 12 1 10 5 16 15 16 29 0 8-1 14-2 21z"],
    detail: ["M57 29c5 6 8 14 8 24", "M33 44l5-2"], dots: [[44, 30, 2.8]],
  },
  q: {
    body: [...PLINTH, "M31 72l-7-35 11 12 4-21 11 18 11-18 4 21 11-12-7 35z"],
    circles: [[24, 34, 4.5], [39, 25, 4.5], [50, 22, 5], [61, 25, 4.5], [76, 34, 4.5]], detail: ["M33 64h34"],
  },
  k: {
    body: [...PLINTH, "M32 72c1-11 5-19 9-25h18c4 6 8 14 9 25z", "M38 44c0-8 5-13 12-13s12 5 12 13z", "M47 31v-9h-6v-6h6V9h6v7h6v6h-6v9z"],
    ellipses: [[50, 46, 15, 3.8]], detail: ["M36 62h28"],
  },
};

/** Jeu « Épuré » : formes géométriques pleines, sans détail, très lisibles en petit. */
const FLAT: Record<PieceType, Shape> = {
  p: { body: ["M32 86h36l-8-30H40z"], circles: [[50, 42, 13]] },
  r: { body: ["M28 86h44V68l-6-4V40h6V18h-9v8h-8v-8h-10v8h-8v-8h-9v22h6v24l-6 4z"] },
  b: { body: ["M30 86h40l-6-14H36z", "M50 12c13 10 18 22 15 34-2 9-8 14-15 14s-13-5-15-14c-3-12 2-24 15-34z"] },
  n: { body: ["M28 86h46c2-22 0-46-14-60-5-5-11-8-17-9l-2 8-14 14c-3 3-3 8 1 10l5 2 10-6c2 6-2 12-8 18-6 7-7 13-7 23z"] },
  q: { body: ["M28 86h44l6-52-14 18-6-30-8 24-8-24-6 30-14-18z"] },
  k: { body: ["M28 86h44l-4-34H32z", "M45 52V36h-9v-9h9V14h10v13h9v9h-9v16z"] },
};

/** Jeu « Pixel » : grilles 12×12 (# = corps, x = contour, o = détail). */
const PIXEL: Record<PieceType, string[]> = {
  p: ["............", "....xxxx....", "...x####x...", "...x####x...", "....xxxx....", "....x##x....", "...x####x...", "....x##x....", "...x####x...", "..x######x..", "..xxxxxxxx..", "............"],
  r: ["............", "..xx.xx.xx..", "..x#x##x#x..", "..x######x..", "...x####x...", "...x####x...", "...x####x...", "...x####x...", "..x######x..", ".x########x.", ".xxxxxxxxxx.", "............"],
  b: [".....xx.....", "....x##x....", "...x##x#x...", "...x#x##x...", "...x####x...", "....x##x....", "...xxxxxx...", "....x##x....", "...x####x...", "..x######x..", "..xxxxxxxx..", "............"],
  n: ["............", "....xx......", "...x##xxx...", "..x#o####x..", ".x#######x..", ".xxx#x###x..", "...xx####x..", "....x####x..", "...x#####x..", "..x######x..", "..xxxxxxxx..", "............"],
  q: ["............", ".x...xx...x.", "x#x.x##x.x#x", ".x#x####x#x.", ".x########x.", "..x######x..", "...x####x...", "...x####x...", "..xxxxxxxx..", "..x######x..", ".x########x.", ".xxxxxxxxxx."],
  k: [".....xx.....", "...xx##xx...", "...x####x...", "...xx##xx...", ".xx.x##x.xx.", "x##xx##xx##x", "x##########x", ".x########x.", "..x######x..", "..xxxxxxxx..", ".x########x.", ".xxxxxxxxxx."],
};

/** Jeu « Lettres » : initiales françaises (R, D, T, F, C) ; le pion est un simple jeton. */
const LETTER: Record<PieceType, string> = { k: "R", q: "D", r: "T", b: "F", n: "C", p: "" };

function ShapeSvg({ shape, fill, stroke, detail, strokeWidth = 3, fillOpacity, filter, noDetail }: {
  shape: Shape; fill: string; stroke: string; detail: string; strokeWidth?: number; fillOpacity?: number; filter?: string; noDetail?: boolean;
}) {
  if (noDetail) shape = { ...shape, detail: undefined, dots: undefined };
  return (
    <g filter={filter}>
      <g fill={fill} fillOpacity={fillOpacity} stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round">
        {shape.body.map((d, i) => <path key={i} d={d} />)}
        {shape.ellipses?.map(([cx, cy, rx, ry], i) => <ellipse key={`e${i}`} cx={cx} cy={cy} rx={rx} ry={ry} />)}
        {shape.circles?.map(([cx, cy, r], i) => <circle key={`c${i}`} cx={cx} cy={cy} r={r} />)}
      </g>
      {shape.detail && (
        <g fill="none" stroke={detail} strokeWidth={3} strokeLinecap="round" opacity={0.85}>
          {shape.detail.map((d, i) => <path key={i} d={d} />)}
        </g>
      )}
      {shape.dots?.map(([cx, cy, r], i) => <circle key={`d${i}`} cx={cx} cy={cy} r={r} fill={detail} />)}
    </g>
  );
}

/** Pixels regroupés par segments horizontaux (quelques dizaines de rectangles par pièce). */
function PixelSvg({ rows, body, shade, edge, eye }: { rows: string[]; body: string; shade: string; edge: string; eye: string }) {
  const rects: Array<{ x: number; y: number; w: number; c: string }> = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x]!;
      if (ch === ".") { x++; continue; }
      let w = 1;
      while (row[x + w] === ch) w++;
      rects.push({ x, y, w, c: ch === "x" ? edge : ch === "o" ? eye : y >= 7 ? shade : body });
      x += w;
    }
  });
  return (
    <svg viewBox="-0.6 -0.9 13.2 13.2" width="100%" height="100%" aria-hidden focusable="false" shapeRendering="crispEdges" style={{ display: "block" }}>
      {rects.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w + 0.02} height={1.02} fill={r.c} />)}
    </svg>
  );
}

export const PieceSvg = memo(function PieceSvg({ code, set = "arena" }: { code: PieceCode; set?: PieceSetId }) {
  const color = code[0] as Color;
  const type = code[1] as PieceType;
  const w = color === "w";
  const fill = w ? "url(#arena-pw)" : "url(#arena-pb)";
  const stroke = w ? "var(--pw-stroke)" : "var(--pb-stroke)";
  const detail = w ? "var(--pw-detail)" : "var(--pb-detail)";
  const c0 = w ? "var(--pw-0)" : "var(--pb-0)";
  const c1 = w ? "var(--pw-1)" : "var(--pb-1)";

  if (set === "pixel") return <PixelSvg rows={PIXEL[type]} body={c0} shade={c1} edge={stroke} eye={detail} />;

  if (set === "letters") {
    const big = type !== "p";
    return (
      <svg viewBox="5 4 90 90" width="100%" height="100%" aria-hidden focusable="false" style={{ display: "block" }}>
        <circle cx={50} cy={50} r={big ? 34 : 22} fill={fill} stroke={stroke} strokeWidth={3.5} />
        {type === "k" && <circle cx={50} cy={50} r={28} fill="none" stroke={detail} strokeWidth={2} opacity={0.7} />}
        {big && (
          <text x={50} y={51} textAnchor="middle" dominantBaseline="central" fill={detail}
            style={{ font: "800 40px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif" }}>{LETTER[type]}</text>
        )}
      </svg>
    );
  }

  const shape = set === "classic" || set === "relief" || set === "sketch" || set === "turned" || set === "woodgrain" || set === "marble" ? CLASSIC[type]
    : set === "flat" ? FLAT[type] : SHAPES[type];
  const turn = <ShapeSvg shape={shape} fill="url(#arena-turn)" stroke="none" detail="none" strokeWidth={0} noDetail />;
  /** pièce « matière » : aplat texturé, ombrage cylindrique, reflet, contour net par-dessus */
  const material = (texture?: string) => (
    <g filter="url(#arena-shadow)">
      <g filter={texture}><ShapeSvg shape={shape} fill={fill} stroke="none" detail="none" strokeWidth={0} noDetail /></g>
      {turn}
      <ShapeSvg shape={shape} fill="none" stroke={stroke} detail={detail} strokeWidth={2.2} />
    </g>
  );
  const gloss = <ShapeSvg shape={shape} fill="url(#arena-gloss)" stroke="none" detail="none" strokeWidth={0} noDetail />;
  return (
    <svg viewBox="5 4 90 90" width="100%" height="100%" aria-hidden focusable="false" style={{ display: "block", overflow: "visible" }}>
      {set === "relief" ? (
        // volume : dégradé + reflet + ombre portée
        <g filter="url(#arena-shadow)">
          <ShapeSvg shape={shape} fill={fill} stroke={stroke} detail={detail} strokeWidth={2.5} />
          {gloss}
        </g>
      ) : set === "sketch" ? (
        // dessin au crayon : trait tremblé, aplat léger
        <g filter="url(#arena-sketch)">
          {/* aplat légèrement décalé, comme une couleur posée au crayon, puis le trait par-dessus */}
          <g transform="translate(2.5 2)" opacity={0.85}><ShapeSvg shape={shape} fill={w ? c1 : c1} stroke="none" detail="none" strokeWidth={0} noDetail /></g>
          <ShapeSvg shape={shape} fill={w ? c0 : c1} fillOpacity={w ? 0.9 : 0.75} stroke={stroke} detail={detail} strokeWidth={2.6} />
          <ShapeSvg shape={shape} fill="none" stroke={stroke} detail={detail} strokeWidth={1.4} />
        </g>
      ) : set === "turned" ? (
        material()
      ) : set === "woodgrain" ? (
        material("url(#arena-wood)")
      ) : set === "marble" ? (
        material("url(#arena-marble)")
      ) : set === "crystal" ? (
        // cristal : corps translucide, arêtes nettes, reflet
        <>
          <ShapeSvg shape={shape} fill={w ? c0 : c1} fillOpacity={w ? 0.55 : 0.7} stroke={w ? stroke : detail} detail={detail} strokeWidth={2.4} />
          {gloss}
        </>
      ) : set === "outline" ? (
        w ? (
          // blanc : silhouette évidée (double trait : lisible sur toutes les cases)
          <>
            <ShapeSvg shape={{ ...shape, detail: undefined, dots: undefined }} fill="none" stroke={stroke} detail={detail} strokeWidth={7} />
            <ShapeSvg shape={shape} fill="none" stroke={c0} detail={detail} strokeWidth={3.5} />
          </>
        ) : (
          <ShapeSvg shape={shape} fill={c1} stroke={detail} detail={detail} strokeWidth={3.5} />
        )
      ) : set === "flat" ? (
        <ShapeSvg shape={shape} fill={w ? c0 : c1} stroke={stroke} detail={detail} strokeWidth={2.5} />
      ) : (
        <ShapeSvg shape={shape} fill={fill} stroke={stroke} detail={detail} />
      )}
    </svg>
  );
});

export const PIECE_NAMES: Record<PieceType, string> = { p: "pion", n: "cavalier", b: "fou", r: "tour", q: "dame", k: "roi" };
