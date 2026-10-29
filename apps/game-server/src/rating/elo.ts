/**
 * Classement Elo à facteur K dynamique (règles inspirées de la FIDE, Handbook B.02 §8.3).
 *
 *   K = 40  compte « nouveau » : moins de 30 parties classées dans la cadence
 *   K = 10  compte établi ayant atteint 2400 (le plafond est conservé : `peak`)
 *   K = 20  sinon
 *
 * Score attendu : E = 1 / (1 + 10^((Rb − Ra)/400)), avec l'écart borné à ±400
 * (règle FIDE des 400 points : une victoire contre beaucoup plus faible rapporte
 * toujours un minimum).
 *
 * Chaque joueur utilise SON K : la somme des variations n'est pas forcément nulle
 * (comportement voulu, identique à la FIDE).
 */
export const PROVISIONAL_GAMES = 30;
export const ELITE_THRESHOLD = 2400;
export const RATING_FLOOR = 100;
export const RATING_CEILING = 4000;
export const MAX_RATING_DIFF = 400;

export type Score = 0 | 0.5 | 1;

export interface RatingState {
  rating: number;
  /** parties classées déjà jouées dans cette cadence */
  games: number;
  /** meilleur classement jamais atteint (K=10 définitif au-delà de 2400) */
  peak: number;
}

export function kFactor(s: RatingState): 40 | 20 | 10 {
  if (s.games < PROVISIONAL_GAMES) return 40;
  if (Math.max(s.peak, s.rating) >= ELITE_THRESHOLD) return 10;
  return 20;
}

export function expectedScore(ra: number, rb: number): number {
  const diff = Math.max(-MAX_RATING_DIFF, Math.min(MAX_RATING_DIFF, rb - ra));
  return 1 / (1 + 10 ** (diff / 400));
}

export interface RatingChange {
  before: number;
  after: number;
  delta: number;
  k: number;
  expected: number;
}

/** Variation d'un joueur A contre B ; `score` du point de vue de A. */
export function ratingChange(a: RatingState, opponentRating: number, score: Score): RatingChange {
  const k = kFactor(a);
  const expected = expectedScore(a.rating, opponentRating);
  const after = clamp(Math.round(a.rating + k * (score - expected)));
  return { before: a.rating, after, delta: after - a.rating, k, expected };
}

/** Variations des deux joueurs d'une partie. `whiteScore` : 1, 0.5 ou 0. */
export function computeGameRatings(white: RatingState, black: RatingState, whiteScore: Score): { white: RatingChange; black: RatingChange } {
  return {
    white: ratingChange(white, black.rating, whiteScore),
    black: ratingChange(black, white.rating, (1 - whiteScore) as Score),
  };
}

export function scoreFromResult(result: "1-0" | "0-1" | "1/2-1/2"): Score {
  return result === "1-0" ? 1 : result === "0-1" ? 0 : 0.5;
}

/** Nouvel état après une partie classée. */
export function nextState(s: RatingState, c: RatingChange): RatingState {
  return { rating: c.after, games: s.games + 1, peak: Math.max(s.peak, c.after) };
}

const clamp = (r: number) => Math.max(RATING_FLOOR, Math.min(RATING_CEILING, r));

/** @deprecated API du Sprint 0, conservée pour compatibilité. */
export function updateElo(a: { rating: number; games: number }, b: { rating: number; games: number }, score: Score) {
  const r = computeGameRatings({ ...a, peak: a.rating }, { ...b, peak: b.rating }, score);
  return { a: r.white.after, b: r.black.after };
}
