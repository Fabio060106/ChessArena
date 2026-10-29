/**
 * Règles de décision anti-triche v2.
 *
 * RÈGLE DE BLOCAGE (spécification Sprint 3) — `HOLD` → statut WITHDRAWAL_HOLD :
 *   sur les 3 dernières parties ÉLIGIBLES du joueur (≥ minAnalysedMoves coups retenus),
 *     (a) ACPL < acplMax dans CHACUNE des 3 parties,
 *     (b) taux de coïncidence moteur ≥ matchMin, calculé sur l'ensemble des coups
 *         des 3 parties (moyenne pondérée par le nombre de coups, pas moyenne de moyennes),
 *     (c) Elo du joueur < ratingCeiling (Elo de la partie la plus récente),
 *     (d) les 3 analyses sont à profondeur ≥ confirmDepth.
 *   Si (a)(b)(c) sont vrais mais (d) ne l'est pas (analyses de triage, profondeur 12),
 *   le verdict est `CONFIRM` : les parties manquantes sont réanalysées en profondeur
 *   AVANT tout blocage. Le joueur passe sous surveillance entre-temps.
 *
 * Les parties non éligibles (trop courtes) sont ignorées : elles ne « cassent » pas
 * la série et ne la complètent pas non plus.
 *
 * SURVEILLANCE (`WATCH`) : score de 0 à 100 combinant les signaux faibles (ACPL bas,
 * coïncidence élevée, pertes de focus, temps anormalement réguliers). Un joueur
 * ≥ ratingCeiling qui remplit (a)(b) est mis en WATCH (revue humaine), jamais bloqué
 * automatiquement : à haut niveau, un ACPL bas est normal.
 *
 * Toute décision finale (bannissement, confiscation) reste HUMAINE.
 */
export const RULE_VERSION = "2026.10-v2";

export interface RuleConfig {
  window: number;
  minAnalysedMoves: number;
  acplMax: number;          // strict : ACPL < acplMax
  matchMin: number;         // ≥
  ratingCeiling: number;    // strict : Elo < ratingCeiling
  confirmDepth: number;     // profondeur minimale des analyses pour un blocage
  watchScore: number;
  focusLossPerGame: number;
  lowTimeCv: number;
}

export const DEFAULT_RULES: RuleConfig = {
  window: 3,
  minAnalysedMoves: 15,
  acplMax: 10,
  matchMin: 0.8,
  ratingCeiling: 2000,
  confirmDepth: 18,
  watchScore: 40,
  focusLossPerGame: 3,
  lowTimeCv: 0.35,
};

/** Statistiques d'un joueur sur une partie, à la meilleure profondeur disponible. */
export interface GameStat {
  gameId: string;
  endedAt: string;
  depth: number;
  rating: number;
  analysedMoves: number;
  acpl: number;
  engineMatchRate: number;
  timeCv: number;
  focusLoss: number;
}

export type Verdict = "CLEAN" | "WATCH" | "CONFIRM" | "HOLD";

export interface RuleOutcome {
  verdict: Verdict;
  score: number;
  reasons: string[];
  /** parties de la fenêtre (les plus récentes en dernier) */
  windowGameIds: string[];
  /** parties à réanalyser en profondeur (verdict CONFIRM) */
  needsDeepAnalysis: string[];
  pooledMatchRate: number | null;
}

export function evaluatePlayer(historyChrono: GameStat[], rules: RuleConfig = DEFAULT_RULES): RuleOutcome {
  const eligible = historyChrono.filter((g) => g.analysedMoves >= rules.minAnalysedMoves);
  const window = eligible.slice(-rules.window);
  const ids = window.map((g) => g.gameId);
  if (window.length < rules.window) {
    return { verdict: "CLEAN", score: 0, reasons: ["échantillon insuffisant"], windowGameIds: ids, needsDeepAnalysis: [], pooledMatchRate: null };
  }

  const totalMoves = window.reduce((a, g) => a + g.analysedMoves, 0);
  const pooledMatch = window.reduce((a, g) => a + g.engineMatchRate * g.analysedMoves, 0) / totalMoves;
  const rating = window.at(-1)!.rating;
  const allLowAcpl = window.every((g) => g.acpl < rules.acplMax);
  const highMatch = pooledMatch >= rules.matchMin - 1e-9;
  const reasons: string[] = [];

  let score = 0;
  if (allLowAcpl) { score += 40; reasons.push(`ACPL < ${rules.acplMax} sur ${rules.window} parties consécutives (${window.map((g) => g.acpl.toFixed(1)).join(" / ")})`); }
  if (highMatch) { score += 35; reasons.push(`coïncidence moteur ${(pooledMatch * 100).toFixed(1)} % sur ${totalMoves} coups`); }
  const avgFocus = window.reduce((a, g) => a + g.focusLoss, 0) / window.length;
  if (avgFocus >= rules.focusLossPerGame) { score += 15; reasons.push(`${avgFocus.toFixed(1)} pertes de focus par partie`); }
  const avgCv = window.reduce((a, g) => a + g.timeCv, 0) / window.length;
  if (avgCv > 0 && avgCv < rules.lowTimeCv) { score += 10; reasons.push(`temps de réflexion anormalement réguliers (CV ${avgCv.toFixed(2)})`); }
  score = Math.min(100, score);

  const pattern = allLowAcpl && highMatch;
  if (pattern && rating < rules.ratingCeiling) {
    const shallow = window.filter((g) => g.depth < rules.confirmDepth).map((g) => g.gameId);
    if (shallow.length > 0) {
      return { verdict: "CONFIRM", score, reasons: [...reasons, `confirmation en profondeur ${rules.confirmDepth} requise`], windowGameIds: ids, needsDeepAnalysis: shallow, pooledMatchRate: pooledMatch };
    }
    return { verdict: "HOLD", score, reasons, windowGameIds: ids, needsDeepAnalysis: [], pooledMatchRate: pooledMatch };
  }
  if (pattern) reasons.push(`Elo ${rating} ≥ ${rules.ratingCeiling} : revue humaine, pas de blocage automatique`);
  if (pattern || score >= rules.watchScore) {
    return { verdict: "WATCH", score, reasons, windowGameIds: ids, needsDeepAnalysis: [], pooledMatchRate: pooledMatch };
  }
  return { verdict: "CLEAN", score, reasons, windowGameIds: ids, needsDeepAnalysis: [], pooledMatchRate: pooledMatch };
}

/**
 * Évaluation sur TOUTES les fenêtres glissantes d'un historique (calibration) :
 * retourne pour chaque fenêtre si la règle de blocage se déclencherait (profondeur ignorée).
 */
export function slidingHoldFlags(historyChrono: GameStat[], rules: RuleConfig = DEFAULT_RULES): boolean[] {
  const eligible = historyChrono.filter((g) => g.analysedMoves >= rules.minAnalysedMoves).map((g) => ({ ...g, depth: Infinity }));
  const flags: boolean[] = [];
  for (let end = rules.window; end <= eligible.length; end++) {
    flags.push(evaluatePlayer(eligible.slice(end - rules.window, end), rules).verdict === "HOLD");
  }
  return flags;
}
