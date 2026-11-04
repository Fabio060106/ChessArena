"use client";
import { memo, useEffect, useRef } from "react";
import type { Color } from "@chessarena/shared";
import { LOW_TIME_MS, formatClock } from "../lib/clock";
import { sound } from "../lib/sound";

type Subscribe = (fn: (c: Record<Color, number>) => void) => () => void;

interface Props {
  color: Color;
  subscribe: Subscribe;
  /** pendule de ce camp en marche */
  active: boolean;
  /** temps initial de la cadence (barre de progression) */
  initialMs: number;
  /** alerte sonore « temps faible » : seulement pour la pendule du joueur */
  alert: boolean;
}

/**
 * Pendule e-sport. Les valeurs arrivent à chaque frame (rAF, base de temps monotone synchronisée
 * sur le serveur) et sont écrites DIRECTEMENT dans le DOM : zéro rendu React par seconde, aucune
 * dérive entre les deux pendules. Sous 10 s : affichage au centième, pulsation, alerte sonore.
 */
export const ChessClock = memo(function ChessClock({ color, subscribe, active, initialMs, alert }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const prev = useRef<{ label: string; low: boolean; ms: number }>({ label: "", low: false, ms: Infinity });

  useEffect(() => subscribe((c) => {
    const ms = c[color];
    const label = initialMs > 0 ? formatClock(ms) : "–:––"; // pas de partie : pas de temps à afficher
    const low = initialMs > 0 && ms < LOW_TIME_MS;
    const p = prev.current;
    if (label !== p.label && text.current) text.current.textContent = label;
    if (low !== p.low) box.current?.classList.toggle("low", low);
    // franchissement du seuil en jeu (pas au chargement d'une partie déjà sous 10 s)
    if (alert && active && low && p.ms >= LOW_TIME_MS && p.ms !== Infinity) sound.play("lowTime");
    if (bar.current && initialMs > 0) bar.current.style.transform = `scaleX(${Math.max(0, Math.min(1, ms / initialMs))})`;
    prev.current = { label, low, ms };
  }), [subscribe, color, alert, active, initialMs]);

  return (
    <div
      ref={box}
      className={`clock relative overflow-hidden rounded-lg px-3 py-1.5 text-2xl font-semibold sm:px-4 sm:text-3xl ${active ? "active" : "idle"}`}
      role="timer"
      aria-live="off"
      aria-label={`Pendule des ${color === "w" ? "blancs" : "noirs"}`}
    >
      <span ref={text} className="relative z-10 block min-w-[4.2ch] text-right">{" "}</span>
      <div ref={bar} className="clock-bar absolute inset-x-0 bottom-0 h-[3px] bg-current opacity-30" />
    </div>
  );
});
