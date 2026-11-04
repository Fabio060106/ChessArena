import type { Color, GameStateEvent } from "@chessarena/shared";

/**
 * Horloge côté client — AFFICHAGE uniquement. Le serveur arbitre (ADR-8).
 *
 * offset = horloge serveur − horloge client, estimé par ping/pong (algorithme de
 * Cristian). On garde l'échantillon au plus petit RTT : c'est le moins bruité.
 */
export interface OffsetSample {
  rttMs: number;
  offsetMs: number;
}

export function offsetFromPing(t0: number, t1: number, serverTs: number): OffsetSample {
  const rttMs = Math.max(0, t1 - t0);
  return { rttMs, offsetMs: serverTs - (t0 + rttMs / 2) };
}

export function bestSample(samples: OffsetSample[]): OffsetSample | null {
  return samples.reduce<OffsetSample | null>((best, s) => (!best || s.rttMs < best.rttMs ? s : best), null);
}

/**
 * Synchronisation haute précision avec l'horloge du serveur.
 *
 * Base de temps MONOTONE (`performance.now()`, résolution sub-milliseconde) : un
 * réglage de l'horloge système pendant la partie ne fait pas sauter la pendule.
 * Le serveur horodate à la milliseconde (`serverTs`) ; l'erreur résiduelle est bornée
 * par la moitié du plus petit RTT observé (asymétrie du réseau), affichée par `errorBoundMs`.
 *
 *   serverNow ≈ performance.now() + offsetMs
 */
export class ClockSync {
  private samples: OffsetSample[] = [];

  constructor(private readonly window = 12) {}

  /** t0/t1 en `performance.now()`, serverTs en ms epoch serveur. */
  add(t0: number, t1: number, serverTs: number): void {
    const s = offsetFromPing(t0, t1, serverTs);
    if (s.rttMs > 5_000) return;
    this.samples.push(s);
    if (this.samples.length > this.window) this.samples.shift();
  }

  get ready(): boolean {
    return this.samples.length > 0;
  }

  get offsetMs(): number {
    return bestSample(this.samples)?.offsetMs ?? Date.now() - performance.now();
  }

  /** RTT du meilleur échantillon récent (ms) — ping local, null avant la 1re mesure. */
  get rttMs(): number | null {
    return bestSample(this.samples)?.rttMs ?? null;
  }

  /** Borne d'erreur de la synchro (ms). */
  get errorBoundMs(): number | null {
    const r = this.rttMs;
    return r === null ? null : r / 2;
  }

  serverNow(perfNow = performance.now()): number {
    return perfNow + this.offsetMs;
  }
}

/**
 * Temps affichés à l'instant `clientNow`. Le camp au trait est décompté depuis
 * `serverTs` ; la pendule ne tourne qu'à partir du 3e demi-coup (ply ≥ 2).
 */
export function displayedClocks(
  state: Pick<GameStateEvent, "whiteMs" | "blackMs" | "turn" | "ply" | "serverTs">,
  offsetMs: number,
  clientNow: number,
  stopped = false,
): Record<Color, number> {
  const running: Color | null = !stopped && state.ply >= 2 ? state.turn : null;
  const elapsed = Math.max(0, clientNow + offsetMs - state.serverTs);
  return {
    w: running === "w" ? Math.max(0, state.whiteMs - elapsed) : state.whiteMs,
    b: running === "b" ? Math.max(0, state.blackMs - elapsed) : state.blackMs,
  };
}

/** Seuil de l'alerte « temps faible » (pulse visuel + son). */
export const LOW_TIME_MS = 10_000;

/**
 * 2:59 au-dessus de 20 s ; 19.4 (dixièmes) de 20 à 10 s ; 9.87 (centièmes) sous 10 s.
 * Les centièmes rendent visible la précision de la synchro dans les fins de bullet.
 */
export function formatClock(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < LOW_TIME_MS) return (Math.floor(clamped / 10) / 100).toFixed(2);
  if (clamped < 20_000) return (Math.floor(clamped / 100) / 10).toFixed(1);
  const totalSec = Math.floor(clamped / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
