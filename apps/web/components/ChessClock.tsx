"use client";
import { formatClock } from "../lib/clock";

interface Props {
  ms: number;
  active: boolean;
  label: string;
  rating?: number;
  disconnectedGraceMs?: number | null;
  /** pièces prises par ce joueur et son avance matérielle (+1, +3…) */
  material?: { captured: string; plus: number };
}

export function ChessClock({ ms, active, label, rating, disconnectedGraceMs, material }: Props) {
  const low = ms < 20_000;
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="truncate font-semibold">{label}</p>
        <p className="text-sm text-neutral-500">
          {rating !== undefined && <span>{rating}</span>}
          {material && (material.captured || material.plus > 0) && (
            <span className="ml-2 tracking-tight text-neutral-600 dark:text-neutral-400" aria-label={`Avance matérielle : ${material.plus}`}>
              {material.captured}
              {material.plus > 0 && <span className="ml-1 font-semibold text-neutral-800 dark:text-neutral-200">+{material.plus}</span>}
            </span>
          )}
          {disconnectedGraceMs != null && (
            <span className="ml-2 text-amber-600">déconnecté — forfait dans {Math.ceil(disconnectedGraceMs / 1000)} s</span>
          )}
        </p>
      </div>
      <time
        aria-live={active && low ? "polite" : "off"}
        className={[
          "rounded-md px-3 py-1.5 font-mono text-2xl tabular-nums transition-colors",
          active ? (low ? "bg-red-600 text-white" : "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900")
            : "bg-neutral-200 text-neutral-500 dark:bg-neutral-800",
        ].join(" ")}
      >
        {formatClock(ms)}
      </time>
    </div>
  );
}
