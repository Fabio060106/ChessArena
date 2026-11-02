"use client";
import { useState } from "react";
import type { TimeControlId } from "@chessarena/shared";

const OPTIONS: Array<{ id: TimeControlId; label: string; family: string }> = [
  { id: "bullet_1_0", label: "1 + 0", family: "Bullet" },
  { id: "blitz_3_0", label: "3 + 0", family: "Blitz" },
  { id: "blitz_3_2", label: "3 + 2", family: "Blitz" },
  { id: "rapid_5_0", label: "5 + 0", family: "Rapid" },
];

const PLAY_STAKES = [0, 100, 200, 500];

interface Props {
  queued: TimeControlId | null;
  /** mise de la file en attente (centimes), pour l'afficher */
  queuedStake?: number | null;
  /** mise présélectionnée : celle de la dernière partie, pour ne pas se retrouver dans une autre file que l'adversaire */
  defaultStake?: number;
  disabled: boolean;
  onJoin: (tc: TimeControlId, buyInCents: number) => void;
  onLeave: () => void;
}

/**
 * Choix de la mise et de la cadence. Cliquer une autre cadence pendant l'attente CHANGE de file
 * (les deux joueurs doivent choisir la même cadence ET la même mise pour être appariés).
 */
export function Lobby({ queued, queuedStake, defaultStake, disabled, onJoin, onLeave }: Props) {
  const [stake, setStake] = useState(defaultStake ?? 200);
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">Mise (jetons PLAY, sans valeur)</h2>
        <div className="flex gap-2">
          {PLAY_STAKES.map((s) => (
            <button key={s} onClick={() => setStake(s)}
              className={`flex-1 rounded-md border px-2 py-1.5 text-sm ${stake === s ? "border-emerald-600 bg-emerald-50 font-semibold dark:bg-emerald-950" : "border-neutral-300 dark:border-neutral-700"}`}>
              {s === 0 ? "Gratuit" : (s / 100).toFixed(0)}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {OPTIONS.map((o) => {
          const isQueued = queued === o.id;
          return (
            <button key={o.id} disabled={disabled}
              onClick={() => (isQueued ? onLeave() : onJoin(o.id, stake))}
              className={`rounded-lg border p-4 text-left transition disabled:opacity-40 ${isQueued ? "animate-pulse border-emerald-600 bg-emerald-600 text-white" : "border-neutral-300 hover:border-emerald-600 dark:border-neutral-700"}`}>
              <span className="block font-mono text-2xl">{o.label}</span>
              <span className="text-sm opacity-80">{isQueued ? "Recherche… (cliquer pour annuler)" : o.family}</span>
            </button>
          );
        })}
      </div>
      {queued && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400" role="status">
          En attente d'un adversaire : <b>{OPTIONS.find((o) => o.id === queued)?.family} {OPTIONS.find((o) => o.id === queued)?.label}</b>,
          mise <b>{!queuedStake ? "Gratuit" : (queuedStake / 100).toFixed(0)}</b>. Ton adversaire doit choisir exactement la même chose.
        </p>
      )}
    </section>
  );
}
