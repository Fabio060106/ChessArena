"use client";
import type { Color, MoveAnalysis } from "@chessarena/shared";
import { formatEval, formatMs, gradeMove, GRADE_LABEL, moveNumber } from "../../lib/anticheatView";

const EXCLUDED: Record<string, string> = { opening: "ouverture", forced: "forcé", extreme_eval: "partie jouée", untimed: "non chronométré" };

/** Table de lecture du PGN annoté : c'est aussi la « vue tableau » accessible du graphique. */
export function MoveTable({ moves, suspectColor, selectedPly, onSelect }: {
  moves: MoveAnalysis[];
  suspectColor: Color;
  selectedPly: number | null;
  onSelect: (ply: number) => void;
}) {
  return (
    <div className="max-h-[420px] overflow-auto rounded-md border border-neutral-200 dark:border-neutral-800">
      <table className="w-full text-left text-xs tabular-nums">
        <thead className="sticky top-0 bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
          <tr>
            <th className="px-2 py-1.5">Coup</th>
            <th className="px-2 py-1.5">Joué</th>
            <th className="px-2 py-1.5">Moteur</th>
            <th className="px-2 py-1.5 text-right">Éval</th>
            <th className="px-2 py-1.5 text-right">Perte</th>
            <th className="px-2 py-1.5 text-right">Temps</th>
            <th className="px-2 py-1.5">Note</th>
          </tr>
        </thead>
        <tbody>
          {moves.map((m) => {
            const grade = gradeMove(m);
            const suspect = m.color === suspectColor;
            return (
              <tr
                key={m.ply}
                onClick={() => onSelect(m.ply)}
                className={[
                  "cursor-pointer border-t border-neutral-100 dark:border-neutral-900",
                  selectedPly === m.ply ? "bg-blue-50 dark:bg-blue-950" : suspect ? "" : "text-neutral-400",
                  !m.included ? "opacity-60" : "",
                ].join(" ")}
              >
                <td className="px-2 py-1">{moveNumber(m.ply)}</td>
                <td className="px-2 py-1 font-semibold">{m.san}</td>
                <td className="px-2 py-1 font-mono">{m.matched ? "=" : m.bestUci}</td>
                <td className="px-2 py-1 text-right">{formatEval(m.evalAfterWhite)}</td>
                <td className="px-2 py-1 text-right">{m.included ? m.cpLoss : "—"}</td>
                <td className="px-2 py-1 text-right">{m.ply < 2 ? "—" : formatMs(m.timeMs)}</td>
                <td className="px-2 py-1">
                  {!m.included ? <span className="text-neutral-500">exclu ({EXCLUDED[m.excludedBy ?? ""] ?? m.excludedBy})</span>
                    : grade === "blunder" ? <span className="font-semibold text-red-600">{GRADE_LABEL.blunder}</span>
                    : grade === "mistake" ? <span className="text-amber-600">{GRADE_LABEL.mistake}</span>
                    : grade === "best" ? <span className="text-blue-600">{GRADE_LABEL.best}</span>
                    : GRADE_LABEL[grade]}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
