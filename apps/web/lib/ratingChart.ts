import type { RatingPoint } from "@chessarena/shared";

export interface ChartGeometry {
  /** points en pixels, dans l'ordre */
  xy: Array<{ x: number; y: number; p: RatingPoint }>;
  /** chemin SVG de la courbe et de l'aire sous la courbe */
  line: string;
  area: string;
  /** bornes de l'axe vertical (arrondies à 10) et repères */
  min: number;
  max: number;
  ticks: number[];
}

/**
 * Géométrie de la courbe d'Elo : abscisse = numéro de partie (régulier, lisible même avec des pauses),
 * ordonnée = Elo, marge de 10 points au-dessus et au-dessous, au moins 40 points d'amplitude.
 */
export function chartGeometry(points: readonly RatingPoint[], width: number, height: number, pad = { top: 8, bottom: 8 }): ChartGeometry | null {
  if (points.length < 2) return null;
  const rs = points.map((p) => p.rating);
  let min = Math.floor((Math.min(...rs) - 10) / 10) * 10;
  let max = Math.ceil((Math.max(...rs) + 10) / 10) * 10;
  if (max - min < 40) { const mid = Math.round((max + min) / 20) * 10; min = mid - 20; max = mid + 20; }
  const h = height - pad.top - pad.bottom;
  const y = (r: number) => pad.top + (1 - (r - min) / (max - min)) * h;
  const x = (i: number) => (i / (points.length - 1)) * width;
  const xy = points.map((p, i) => ({ x: round(x(i)), y: round(y(p.rating)), p }));
  const line = xy.map((q, i) => `${i ? "L" : "M"}${q.x},${q.y}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const step = niceStep(max - min);
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max; t += step) ticks.push(t);
  return { xy, line, area, min, max, ticks };
}

/** Le point le plus proche d'une abscisse (survol / toucher). */
export function nearestIndex(count: number, x: number, width: number): number {
  if (count < 2) return 0;
  return Math.max(0, Math.min(count - 1, Math.round((x / width) * (count - 1))));
}

/** Variation sur la période affichée et meilleur Elo atteint. */
export function chartSummary(points: readonly RatingPoint[]): { first: number; last: number; delta: number; best: number } | null {
  if (!points.length) return null;
  const first = points[0]!.rating, last = points[points.length - 1]!.rating;
  return { first, last, delta: last - first, best: Math.max(...points.map((p) => p.rating)) };
}

function niceStep(span: number): number {
  for (const s of [10, 20, 25, 50, 100, 200, 250, 500]) if (span / s <= 4) return s;
  return 1000;
}
const round = (n: number) => Math.round(n * 10) / 10;
