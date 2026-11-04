"use client";
import { useState } from "react";
import type { TimeControlId } from "@chessarena/shared";

const OPTIONS: Array<{ id: TimeControlId; label: string; family: string }> = [
  { id: "bullet_1_0", label: "1 + 0", family: "Bullet" },
  { id: "blitz_3_0", label: "3 + 0", family: "Blitz" },
  { id: "blitz_3_2", label: "3 + 2", family: "Blitz" },
  { id: "rapid_5_0", label: "5 + 0", family: "Rapide" },
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
 * Duel 1v1 : choix de la mise (jetons PLAY) et de la cadence. Cliquer une autre cadence pendant
 * l'attente CHANGE de file (les deux joueurs doivent choisir la même cadence ET la même mise).
 */
export function Lobby({ queued, queuedStake, defaultStake, disabled, onJoin, onLeave }: Props) {
  const [stake, setStake] = useState(defaultStake ?? 200);
  return (
    <section className="flex flex-col gap-3" aria-label="Duel 1 contre 1">
      <div>
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Mise · jetons PLAY (sans valeur)</h2>
        <div className="grid grid-cols-4 gap-1.5 rounded-xl bg-surface-2 p-1">
          {PLAY_STAKES.map((s) => (
            <button key={s} type="button" onClick={() => setStake(s)} aria-pressed={stake === s}
              className={`tabular rounded-lg px-2 py-1.5 text-sm font-semibold transition ${stake === s ? "bg-ink text-neon ring-1 ring-neon/50" : "text-muted hover:text-text"}`}>
              {s === 0 ? "Gratuit" : (s / 100).toFixed(0)}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {OPTIONS.map((o) => {
          const isQueued = queued === o.id;
          return (
            <button key={o.id} type="button" disabled={disabled}
              onClick={() => (isQueued ? onLeave() : onJoin(o.id, stake))}
              className={`rounded-xl p-3.5 text-left transition disabled:opacity-35 ${isQueued ? "neon-btn animate-pulse" : "panel hover:border-neon/50"}`}>
              <span className="tabular block font-display text-2xl font-bold">{o.label}</span>
              <span className="text-xs text-muted">{isQueued ? "Recherche… (cliquer pour annuler)" : o.family}</span>
            </button>
          );
        })}
      </div>
      {queued && (
        <p className="text-xs leading-relaxed text-muted" role="status">
          En attente : <b className="text-text">{OPTIONS.find((o) => o.id === queued)?.family} {OPTIONS.find((o) => o.id === queued)?.label}</b>,
          mise <b className="text-text">{!queuedStake ? "Gratuit" : (queuedStake / 100).toFixed(0)}</b>. Ton adversaire doit choisir exactement la même chose.
        </p>
      )}
    </section>
  );
}
