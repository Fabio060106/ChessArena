"use client";
import { formatClock } from "../lib/clock";

interface Props {
  ms: number;
  active: boolean;
  label: string;
  rating?: number;
  disconnectedGraceMs?: number | null;
}

export function ChessClock({ ms, active, label, rating, disconnectedGraceMs }: Props) {
  const low = ms < 20_000;
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="truncate font-semibold">{label}</p>
        <p className="text-sm text-neutral-500">
          {rating !== undefined && <span>{rating}</span>}
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
