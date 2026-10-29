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

/** 2:59 au-dessus de 20 s, 19.4 en dessous (dixièmes), comme sur les plateformes de référence. */
export function formatClock(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 20_000) return (Math.floor(clamped / 100) / 10).toFixed(1);
  const totalSec = Math.floor(clamped / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
