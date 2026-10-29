"use client";
import { useMemo, useRef, useState } from "react";
import type { Color, MoveAnalysis } from "@chessarena/shared";
import { evalToUnit, formatEval, formatMs, gradeMove, moveNumber } from "../../lib/anticheatView";

interface Props {
  moves: MoveAnalysis[];
  suspectColor: Color;
  selectedPly: number | null;
  onSelect: (ply: number) => void;
}

const W = 720;
const H_EVAL = 180;
const H_BARS = 70;
const GAP = 28;
const PAD_L = 36;
const PAD_R = 8;

/**
 * Deux panneaux sur un même axe des demi-coups (pas de double axe vertical) :
 *  1. courbe d'évaluation Stockfish (côté Blancs, échelle écrasée) ;
 *  2. pour le joueur suspect : perte en centipions (vers le haut) et temps de
 *     réflexion (vers le bas), coup par coup.
 * Coups moteur (★) marqués d'un point ; gaffes signalées par un libellé, pas
 * seulement par la couleur. Survol = réticule + infobulle ; clic = position.
 */
export function EvalChart({ moves, suspectColor, selectedPly, onSelect }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const n = Math.max(moves.length, 1);
  const x = (ply: number) => PAD_L + ((ply + 0.5) / n) * (W - PAD_L - PAD_R);
  const yEval = (cp: number) => (H_EVAL / 2) * (1 - evalToUnit(cp));
  const barsTop = H_EVAL + GAP;
  const mid = barsTop + H_BARS;

  const mine = moves.filter((m) => m.color === suspectColor);
  const maxLoss = Math.max(300, ...mine.filter((m) => m.included).map((m) => Math.min(m.cpLoss, 1000)));
  const maxTime = Math.max(5_000, ...mine.map((m) => m.timeMs));
  const bw = Math.max(2, ((W - PAD_L - PAD_R) / n) * 1.6 - 2);

  const path = useMemo(() => {
    if (!moves.length) return { line: "", area: "" };
    const pts = moves.map((m) => [x(m.ply), yEval(m.evalAfterWhite)] as const);
    const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
    const area = `${line}L${pts.at(-1)![0].toFixed(1)},${H_EVAL / 2}L${pts[0]![0].toFixed(1)},${H_EVAL / 2}Z`;
    return { line, area };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moves]);

  const plyAt = (clientX: number): number | null => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || !moves.length) return null;
    const vx = ((clientX - r.left) / r.width) * W;
    const ply = Math.floor(((vx - PAD_L) / (W - PAD_L - PAD_R)) * n);
    return ply >= 0 && ply < moves.length ? ply : null;
  };

  const h = hover !== null ? moves[hover] : null;
  const firstIncluded = moves.find((m) => m.included)?.ply ?? null;

  return (
    <figure className="viz-root relative w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${mid + H_BARS + 18}`}
        className="w-full select-none"
        role="img"
        aria-label="Courbe d'évaluation et pertes par coup"
        onMouseMove={(e) => setHover(plyAt(e.clientX))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => { const p = plyAt(e.clientX); if (p !== null) onSelect(p); }}
      >
        {/* panneau 1 : évaluation */}
        <rect x={PAD_L} y={0} width={W - PAD_L - PAD_R} height={H_EVAL} fill="var(--viz-black-side)" rx={4} />
        <path d={path.area} fill="var(--viz-white-side)" />
        <line x1={PAD_L} x2={W - PAD_R} y1={H_EVAL / 2} y2={H_EVAL / 2} stroke="var(--viz-grid)" strokeWidth={1} />
        {firstIncluded !== null && (
          <>
            <rect x={PAD_L} y={0} width={x(firstIncluded) - PAD_L - 2} height={H_EVAL} fill="var(--viz-excluded)" />
            <text x={PAD_L + 6} y={H_EVAL - 6} className="fill-[var(--viz-white-side)] text-[10px]">ouverture (exclue)</text>
          </>
        )}
        <path d={path.line} fill="none" stroke="var(--viz-series)" strokeWidth={2} strokeLinejoin="round" />
        {mine.filter((m) => m.included && m.matched).map((m) => (
          <circle key={m.ply} cx={x(m.ply)} cy={yEval(m.evalAfterWhite)} r={3} fill="var(--viz-series)" stroke="var(--viz-surface)" strokeWidth={1.5} />
        ))}
        <text x={4} y={12} className="fill-[var(--viz-muted)] text-[10px]">+</text>
        <text x={4} y={H_EVAL - 4} className="fill-[var(--viz-muted)] text-[10px]">−</text>
        <text x={4} y={H_EVAL / 2 + 3} className="fill-[var(--viz-muted)] text-[10px]">0</text>

        {/* panneau 2 : perte (haut) et temps (bas) du joueur suspect */}
        <text x={PAD_L} y={barsTop - 8} className="fill-[var(--viz-muted)] text-[10px]">perte (cp) ↑ · temps ↓ — {suspectColor === "w" ? "Blancs" : "Noirs"}</text>
        <line x1={PAD_L} x2={W - PAD_R} y1={mid} y2={mid} stroke="var(--viz-grid)" strokeWidth={1} />
        {mine.map((m) => {
          const grade = gradeMove(m);
          const lh = m.included ? (Math.min(m.cpLoss, maxLoss) / maxLoss) * H_BARS : 0;
          const th = (m.timeMs / maxTime) * H_BARS;
          return (
            <g key={m.ply} opacity={m.included ? 1 : 0.35}>
              {lh > 0 && <rect x={x(m.ply) - bw / 2} y={mid - lh} width={bw} height={lh} rx={Math.min(2, bw / 2)} fill={grade === "blunder" ? "var(--viz-critical)" : grade === "mistake" ? "var(--viz-warning)" : "var(--viz-bar)"} />}
              <rect x={x(m.ply) - bw / 2} y={mid + 2} width={bw} height={Math.max(1, th)} rx={Math.min(2, bw / 2)} fill="var(--viz-time)" />
              {grade === "blunder" && m.included && <text x={x(m.ply)} y={mid - lh - 3} textAnchor="middle" className="fill-[var(--viz-text)] text-[9px] font-semibold">??</text>}
            </g>
          );
        })}

        {/* réticule de survol + sélection */}
        {selectedPly !== null && <line x1={x(selectedPly)} x2={x(selectedPly)} y1={0} y2={mid + H_BARS} stroke="var(--viz-text)" strokeWidth={1} strokeDasharray="3 3" />}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={mid + H_BARS} stroke="var(--viz-muted)" strokeWidth={1} />}
      </svg>

      {h && (
        <div
          className="pointer-events-none absolute top-0 z-10 w-52 rounded-md border border-[var(--viz-grid)] bg-[var(--viz-surface)] p-2 text-xs shadow-lg"
          style={{ left: `min(calc(${(x(h.ply) / W) * 100}% + 12px), calc(100% - 13rem))` }}
        >
          <p className="font-semibold text-[var(--viz-text)]">{moveNumber(h.ply)} {h.san} <span className="font-normal text-[var(--viz-muted)]">({h.color === "w" ? "Blancs" : "Noirs"})</span></p>
          <p className="text-[var(--viz-muted)]">Éval : {formatEval(h.evalBeforeWhite, h.mateBeforeWhite)} → {formatEval(h.evalAfterWhite)}</p>
          <p className="text-[var(--viz-muted)]">Meilleur : {h.bestUci}{h.matched ? " ★" : ""}</p>
          <p className="text-[var(--viz-muted)]">Perte : {h.cpLoss} cp · Temps : {formatMs(h.timeMs)}</p>
          {!h.included && <p className="text-[var(--viz-muted)]">Exclu : {h.excludedBy}</p>}
        </div>
      )}

      <figcaption className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--viz-muted)]">
        <span><i className="mr-1 inline-block h-0.5 w-4 align-middle bg-[var(--viz-series)]" />évaluation (côté Blancs)</span>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full align-middle bg-[var(--viz-series)]" />coup identique au moteur</span>
        <span><i className="mr-1 inline-block h-2 w-3 align-middle bg-[var(--viz-bar)]" />perte</span>
        <span><i className="mr-1 inline-block h-2 w-3 align-middle bg-[var(--viz-warning)]" />erreur ≥ 100</span>
        <span><i className="mr-1 inline-block h-2 w-3 align-middle bg-[var(--viz-critical)]" />gaffe ≥ 300 (??)</span>
        <span><i className="mr-1 inline-block h-2 w-3 align-middle bg-[var(--viz-time)]" />temps de réflexion</span>
      </figcaption>
    </figure>
  );
}
