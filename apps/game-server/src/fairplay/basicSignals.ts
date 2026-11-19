import type { Color, TimeControlId } from "@chessarena/shared";

/**
 * Anti-triche « de base », sans moteur côté serveur : à la fin de chaque partie, deux signaux FAIBLES
 * sont calculés pour chaque joueur. Ils ne prouvent rien ; ils désignent des parties à faire revoir
 * par l'organisateur (qui lance alors Stockfish sur la partie). Aucune sanction automatique.
 *
 *  - sorties de l'onglet : un tricheur consulte souvent un moteur dans un autre onglet ou une autre fenêtre ;
 *  - régularité des temps : un humain réfléchit vite aux coups évidents et longtemps aux positions
 *    critiques ; un joueur qui recopie un moteur met souvent le même temps à chaque coup.
 */
export interface BasicSignal {
  userId: string;
  color: Color;
  focusLosses: number;
  moves: number;
  /** écart-type / moyenne des temps de réflexion (null si trop peu de coups) */
  timeCv: number | null;
  reasons: string[];
  flagged: boolean;
}

export const SIGNAL_RULES = {
  /** sorties d'onglet à partir desquelles on signale */
  focusLosses: 3,
  /** régularité : au moins N coups chronométrés, temps moyen ≥ 1,5 s, et coefficient de variation sous le seuil */
  minMoves: 15,
  minMeanMs: 1_500,
  maxCv: 0.25,
};

export function timeRegularity(times: readonly number[]): { mean: number; cv: number } | null {
  if (times.length < 2) return null;
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  if (mean <= 0) return null;
  const sd = Math.sqrt(times.reduce((a, t) => a + (t - mean) ** 2, 0) / times.length);
  return { mean, cv: sd / mean };
}

export function basicSignals(g: {
  white: { userId: string }; black: { userId: string };
  timeControl: TimeControlId; moveTimesMs: readonly number[]; focusLoss: Record<Color, number>;
}): BasicSignal[] {
  return (["w", "b"] as const).map((color) => {
    const userId = color === "w" ? g.white.userId : g.black.userId;
    // demi-coups de ce joueur, sans les deux premiers de la partie (non chronométrés)
    const times = g.moveTimesMs.filter((_, i) => (i % 2 === 0 ? "w" : "b") === color && i >= 2);
    const reasons: string[] = [];
    const losses = g.focusLoss[color] ?? 0;
    if (losses >= SIGNAL_RULES.focusLosses) reasons.push(`a quitté l'onglet de la partie ${losses} fois`);
    const reg = timeRegularity(times);
    const cvRule = g.timeControl !== "bullet_1_0" && times.length >= SIGNAL_RULES.minMoves && reg !== null
      && reg.mean >= SIGNAL_RULES.minMeanMs && reg.cv < SIGNAL_RULES.maxCv;
    if (cvRule) reasons.push(`temps de réflexion anormalement réguliers (≈ ${(reg!.mean / 1000).toFixed(1)} s à chaque coup)`);
    return {
      userId, color, focusLosses: losses, moves: times.length,
      timeCv: reg ? Math.round(reg.cv * 1000) / 1000 : null, reasons, flagged: reasons.length > 0,
    };
  });
}
