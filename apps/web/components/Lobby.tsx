"use client";
import { useEffect, useState } from "react";
import type { TimeControlId } from "@chessarena/shared";
import { stakeLabel, waitingFor } from "../lib/queue";

const OPTIONS: Array<{ id: TimeControlId; label: string; family: string }> = [
  { id: "bullet_1_0", label: "1 + 0", family: "Bullet" },
  { id: "blitz_3_0", label: "3 + 0", family: "Blitz" },
  { id: "blitz_3_2", label: "3 + 2", family: "Blitz" },
  { id: "rapid_5_0", label: "5 + 0", family: "Rapide" },
];

const PLAY_STAKES = [0, 100, 200, 500];
const STAKE_KEY = "arena.lobby.stake";

interface Props {
  queued: TimeControlId | null;
  /** mise de la file en attente (centimes), pour l'afficher */
  queuedStake?: number | null;
  /** mise de la dernière partie (prioritaire sur le dernier choix mémorisé) */
  defaultStake?: number;
  /** joueurs en attente par file « cadence|PLAY|mise » (moi compris si je suis en file) */
  stats?: Record<string, number>;
  disabled: boolean;
  onJoin: (tc: TimeControlId, buyInCents: number) => void;
  onLeave: () => void;
}

function rememberedStake(): number {
  try {
    const v = Number(localStorage.getItem(STAKE_KEY));
    if (PLAY_STAKES.includes(v)) return v;
  } catch { /* stockage indisponible */ }
  return 0; // par défaut : gratuit (tout le monde se retrouve dans la même file)
}

/**
 * Duel 1v1 : choix de la mise (jetons PLAY) et de la cadence. Les deux joueurs doivent choisir la même cadence
 * ET la même mise : on affiche qui attend, et dans quelle file, pour qu'on se retrouve.
 */
export function Lobby({ queued, queuedStake, defaultStake, stats = {}, disabled, onJoin, onLeave }: Props) {
  const [stake, setStake] = useState(defaultStake ?? 0);
  // après le chargement : le dernier choix de cet appareil (sauf si une partie vient d'imposer sa mise)
  useEffect(() => { if (defaultStake === undefined) setStake(rememberedStake()); }, [defaultStake]);
  useEffect(() => { if (typeof queuedStake === "number") setStake(queuedStake); }, [queuedStake]);
  const pick = (s: number) => {
    setStake(s);
    try { localStorage.setItem(STAKE_KEY, String(s)); } catch { /* best-effort */ }
  };
  const mineIn = (tc: TimeControlId) => (queued === tc ? queuedStake ?? 0 : null);

  // je suis en file, mais quelqu'un attend à la même cadence avec une autre mise
  const elsewhere = queued ? waitingFor(stats, queued, queuedStake ?? 0, queuedStake ?? 0).other : [];

  return (
    <section className="flex flex-col gap-3" aria-label="Duel 1 contre 1">
      <div>
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Mise · jetons PLAY (sans valeur)</h2>
        <div className="grid grid-cols-4 gap-1.5 rounded-xl bg-surface-2 p-1">
          {PLAY_STAKES.map((s) => (
            <button key={s} type="button" onClick={() => pick(s)} aria-pressed={stake === s}
              className={`tabular rounded-lg px-2 py-1.5 text-sm font-semibold transition ${stake === s ? "bg-ink text-neon ring-1 ring-neon/50" : "text-muted hover:text-text"}`}>
              {s === 0 ? "Gratuit" : (s / 100).toFixed(0)}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {OPTIONS.map((o) => {
          const isQueued = queued === o.id;
          const w = waitingFor(stats, o.id, stake, mineIn(o.id));
          return (
            <button key={o.id} type="button" disabled={disabled}
              onClick={() => (isQueued ? onLeave() : onJoin(o.id, stake))}
              className={`rounded-xl p-3.5 text-left transition disabled:opacity-35 ${isQueued ? "neon-btn animate-pulse" : "panel hover:border-neon/50"}`}>
              <span className="tabular block font-display text-2xl font-bold">{o.label}</span>
              <span className="text-xs text-muted">{isQueued ? "Recherche… (cliquer pour annuler)" : o.family}</span>
              {!isQueued && w.same > 0 && (
                <span className="mt-1 block text-[11px] font-semibold text-win">● {w.same} joueur{w.same > 1 ? "s" : ""} attend{w.same > 1 ? "ent" : ""}</span>
              )}
              {!isQueued && w.same === 0 && w.other.length > 0 && (
                <span className="mt-1 block text-[11px] text-gold">● {w.other.reduce((a, x) => a + x.count, 0)} en attente, autre mise</span>
              )}
            </button>
          );
        })}
      </div>
      {queued && (
        <p className="text-xs leading-relaxed text-muted" role="status">
          En attente : <b className="text-text">{OPTIONS.find((o) => o.id === queued)?.family} {OPTIONS.find((o) => o.id === queued)?.label}</b>,
          mise <b className="text-text">{stakeLabel(queuedStake ?? 0)}</b>. Ton adversaire doit choisir exactement la même chose.
        </p>
      )}
      {queued && elsewhere.length > 0 && (
        <div role="alert" className="rounded-lg border border-gold/50 bg-gold/10 p-2.5 text-sm">
          {elsewhere.map((x) => (
            <div key={x.stake} className="flex flex-wrap items-center gap-2">
              <span className="flex-1">{x.count} joueur{x.count > 1 ? "s" : ""} attend{x.count > 1 ? "ent" : ""} à la même cadence, mise <b>{stakeLabel(x.stake)}</b>.</span>
              <button type="button" className="rounded-lg bg-gold/20 px-2.5 py-1 text-xs font-semibold text-gold hover:bg-gold/30"
                onClick={() => { pick(x.stake); onLeave(); setTimeout(() => onJoin(queued, x.stake), 150); }}>
                Le rejoindre
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
