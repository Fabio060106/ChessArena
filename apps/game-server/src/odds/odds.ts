/**
 * Cotes en direct (pronostics en jetons) : probabilités victoire / nulle / défaite données par Stockfish (WDL),
 * converties en cotes décimales avec une marge de bookmaker.
 *
 * - probabilités planchées à 1 % puis renormalisées (jamais de cote infinie) ;
 * - marge : la somme des probabilités « vendues » vaut 1 + marge (6 %) ;
 * - cotes arrondies vers le bas au centième, bornées à [1,01 ; 30] ;
 * - marché suspendu quand l'issue est quasi certaine (une probabilité > 97 %) : plus rien à parier.
 */
export type Pick = "white" | "draw" | "black";
export const PICKS: readonly Pick[] = ["white", "draw", "black"];

export interface Wdl { w: number; d: number; l: number }
export interface Odds { white: number; draw: number; black: number }

export const MARGIN = 0.06;
export const MIN_ODDS = 1.01;
export const MAX_ODDS = 30;
export const SUSPEND_ABOVE = 0.97;

/**
 * WDL « humain » (pour mille, point de vue des Blancs) à partir de l'évaluation en centipions.
 * Le WDL natif de Stockfish est calibré sur des parties de moteurs (presque toutes nulles) : inutilisable pour des humains.
 * Ici : score attendu logistique (échelle 100 cp : joueurs d'élite, qui convertissent leurs avantages), taux de nulle
 * ~55 % à égalité, qui décroît quand l'avantage grandit (gaussienne de 250 cp). Mat : issue certaine.
 * Exemples : +0,3 → 30 / 54 / 16 % ; +1 → 50 / 47 / 3 % ; +2 → 76 / 24 / 0 %.
 */
export function humanWdl(cp: number, drawAtEqual = 0.55, drawWidth = 250, scale = 100): Wdl {
  if (Math.abs(cp) >= 5_000) return cp > 0 ? { w: 1000, d: 0, l: 0 } : { w: 0, d: 0, l: 1000 };
  const s = 1 / (1 + Math.exp(-cp / scale)); // score attendu des Blancs (élite : un avantage se convertit)
  let d = drawAtEqual * Math.exp(-((cp / drawWidth) ** 2));
  d = Math.min(d, 2 * Math.min(s, 1 - s)); // la nulle ne peut pas dépasser ce que permet le score attendu
  const w = s - d / 2, l = 1 - s - d / 2;
  return { w: Math.round(w * 1000), d: Math.round(d * 1000), l: Math.round(l * 1000) };
}

/** Probabilités (somme 1) du point de vue des Blancs, à partir d'un WDL en pour mille. */
export function probabilities(wdl: Wdl): { white: number; draw: number; black: number } {
  const floor = (x: number) => Math.max(10, x);
  const w = floor(wdl.w), d = floor(wdl.d), l = floor(wdl.l);
  const s = w + d + l;
  return { white: w / s, draw: d / s, black: l / s };
}

export function oddsFromWdl(wdl: Wdl, margin = MARGIN): { odds: Odds; suspended: boolean; probs: { white: number; draw: number; black: number } } {
  const probs = probabilities(wdl);
  const one = (p: number) => Math.min(MAX_ODDS, Math.max(MIN_ODDS, Math.floor((1 / (p * (1 + margin))) * 100) / 100));
  const raw = { w: wdl.w / 1000, d: wdl.d / 1000, l: wdl.l / 1000 };
  return {
    odds: { white: one(probs.white), draw: one(probs.draw), black: one(probs.black) },
    suspended: Math.max(raw.w, raw.d, raw.l) > SUSPEND_ABOVE,
    probs,
  };
}

/** WDL renvoyé par Stockfish (camp au trait) → point de vue des Blancs. */
export function wdlForWhite(wdl: Wdl, turn: "w" | "b"): Wdl {
  return turn === "w" ? wdl : { w: wdl.l, d: wdl.d, l: wdl.w };
}

/** « 1-0 » → white, « 0-1 » → black, « 1/2-1/2 » → draw ; sinon null (partie non terminée ou résultat inconnu). */
export function outcomeOf(result: string | null | undefined): Pick | null {
  if (result === "1-0") return "white";
  if (result === "0-1") return "black";
  if (result === "1/2-1/2" || result === "½-½") return "draw";
  return null;
}

export const marketKey = (relayId: string, round: number, index: number) => `${relayId}:${round}:${index}`;

/** Gain total (mise comprise) d'une mise gagnante, en centimes de jetons. */
export const payoutOf = (stakeCents: number, odds: number) => Math.floor(stakeCents * odds);

/** Mises : de 1 à 25 jetons par pari, au plus 50 jetons engagés par partie et par joueur. */
export const BET_LIMITS = { minCents: 100, maxCents: 2_500, maxOpenPerMarketCents: 5_000 } as const;
