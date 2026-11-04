import { Chess } from "chess.js";

/** Une position de la relecture : 0 = position initiale, i = après le i-ème demi-coup. */
export interface ReplayStep {
  fen: string;
  san: string | null;
  uci: string | null;
}

/** Positions successives d'une partie à partir de son PGN (relecture coup par coup). */
export function replayFromPgn(pgn: string): ReplayStep[] {
  const c = new Chess();
  c.loadPgn(pgn);
  const moves = c.history({ verbose: true });
  const r = new Chess();
  const steps: ReplayStep[] = [{ fen: r.fen(), san: null, uci: null }];
  for (const m of moves) {
    r.move(m.san);
    steps.push({ fen: r.fen(), san: m.san, uci: m.from + m.to + (m.promotion ?? "") });
  }
  return steps;
}

/**
 * Positions d'une partie en cours à partir de la liste des coups (SAN).
 * S'arrête au premier coup inconnu (null, après une reconnexion) : on ne navigue que sur ce qu'on sait rejouer.
 */
export function replayFromSans(sans: ReadonlyArray<string | null>): ReplayStep[] {
  const r = new Chess();
  const steps: ReplayStep[] = [{ fen: r.fen(), san: null, uci: null }];
  for (const san of sans) {
    if (!san) break;
    try {
      const m = r.move(san);
      steps.push({ fen: r.fen(), san: m.san, uci: m.from + m.to + (m.promotion ?? "") });
    } catch { break; }
  }
  return steps;
}

/** « 3 min », « 2 h », « hier », « 12 oct. » */
export function relativeDate(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const s = Math.max(0, (now - d.getTime()) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86_400) return `il y a ${Math.floor(s / 3600)} h`;
  if (s < 2 * 86_400) return "hier";
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: d.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" });
}

/** Temps réfléchi par demi-coup, au format court (« 2,4 s »). */
export function formatThink(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
  return `${Math.round(ms / 1000)} s`;
}
