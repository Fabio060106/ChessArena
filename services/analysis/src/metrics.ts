import { Chess } from "chess.js";
import type { AnalysisRequest, Color, ExclusionReason, MoveAnalysis, PlayerAnalysis } from "@chessarena/shared";
import { MATE_CP, type EngineEval } from "./uci.js";

/**
 * Métriques anti-triche d'une partie.
 *
 * Pour chaque position P_i (avant le demi-coup i), le moteur donne eval(P_i) du point
 * de vue du camp au trait, et son meilleur coup. La perte du demi-coup i vaut :
 *
 *     loss_i = max(0, clamp(eval(P_i)) − clamp(−eval(P_{i+1})))
 *
 * (eval(P_{i+1}) est du point de vue de l'adversaire, d'où le signe), avec des évals
 * bornées à ±EVAL_CAP pour qu'une seule gaffe n'écrase pas la moyenne.
 *
 * Coups EXCLUS (ils ne disent rien sur la triche et fabriquent des faux positifs) :
 *   • opening       — les OPENING_PLIES premiers demi-coups (théorie apprise) ;
 *   • extreme_eval  — |eval avant le coup| > EXTREME_EVAL_CP : partie déjà jouée,
 *                     presque tous les coups « gagnent » ;
 *   • forced        — un seul coup légal.
 * Les temps de réflexion des deux premiers demi-coups (non chronométrés) sont exclus
 * des statistiques de temps (`untimed`) mais pas de l'ACPL.
 */
export interface MetricsConfig {
  openingPlies: number;
  extremeEvalCp: number;
  evalCap: number;
}

export const DEFAULT_METRICS: MetricsConfig = {
  openingPlies: 16,
  extremeEvalCp: 1000,
  evalCap: 1000,
};

export type Evaluator = (fen: string) => Promise<EngineEval>;

interface Position {
  fen: string;
  legal: number;
  terminal: EngineEval | null;
}

function terminalEval(c: Chess): EngineEval | null {
  if (c.isCheckmate()) return { cp: -MATE_CP, mate: 0, bestMove: "(none)" };
  if (c.isStalemate() || c.isInsufficientMaterial()) return { cp: 0, mate: null, bestMove: "(none)" };
  return null;
}

/** Liste des positions et coups d'une partie (PGN standard). */
export function replay(pgn: string): { positions: Position[]; moves: Array<{ san: string; uci: string; color: Color }> } {
  const src = new Chess();
  src.loadPgn(pgn);
  const history = src.history({ verbose: true });
  const board = new Chess();
  const positions: Position[] = [];
  const snap = () => positions.push({ fen: board.fen(), legal: board.moves().length, terminal: terminalEval(board) });
  for (const m of history) {
    snap();
    board.move(m.san);
  }
  snap();
  return {
    positions,
    moves: history.map((m) => ({ san: m.san, uci: m.from + m.to + (m.promotion ?? ""), color: m.color as Color })),
  };
}

/** Évalue toutes les positions (séquentiel : un moteur, hash réutilisé d'une position à la suivante). */
export async function evaluatePositions(positions: Position[], evaluate: Evaluator): Promise<EngineEval[]> {
  const out: EngineEval[] = [];
  for (const p of positions) out.push(p.terminal ?? (await evaluate(p.fen)));
  return out;
}

const clamp = (cp: number, cap: number) => Math.max(-cap, Math.min(cap, cp));
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/** Calcul pur, à partir des évaluations déjà obtenues (testable sans moteur). */
export function computeMoveAnalyses(
  moves: Array<{ san: string; uci: string; color: Color }>,
  positions: Position[],
  evals: EngineEval[],
  moveTimesMs: number[],
  cfg: MetricsConfig = DEFAULT_METRICS,
): MoveAnalysis[] {
  if (evals.length !== moves.length + 1) throw new Error(`évals: ${evals.length}, attendu ${moves.length + 1}`);
  return moves.map((m, i) => {
    const before = evals[i]!;
    const after = evals[i + 1]!;
    const sign = m.color === "w" ? 1 : -1;
    const loss = Math.max(0, clamp(before.cp, cfg.evalCap) - clamp(-after.cp, cfg.evalCap));
    let excludedBy: ExclusionReason | null = null;
    if (i < cfg.openingPlies) excludedBy = "opening";
    else if (positions[i]!.legal <= 1) excludedBy = "forced";
    else if (Math.abs(before.cp) > cfg.extremeEvalCp) excludedBy = "extreme_eval";
    return {
      ply: i,
      color: m.color,
      san: m.san,
      uci: m.uci,
      bestUci: before.bestMove,
      evalBeforeWhite: sign * before.cp,
      evalAfterWhite: -sign * after.cp,
      mateBeforeWhite: before.mate === null ? null : sign * before.mate,
      cpLoss: loss,
      matched: m.uci === before.bestMove,
      timeMs: Math.max(0, Math.round(moveTimesMs[i] ?? 0)),
      included: excludedBy === null,
      excludedBy,
    };
  });
}

export interface TimeStats {
  count: number;
  meanMs: number;
  variance: number; // ms², estimateur non biaisé (n − 1)
  stdMs: number;
  cv: number;       // std / mean ; 0 si moyenne nulle
}

export function timeStats(timesMs: number[]): TimeStats {
  const n = timesMs.length;
  if (n === 0) return { count: 0, meanMs: 0, variance: 0, stdMs: 0, cv: 0 };
  const mean = timesMs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? timesMs.reduce((a, t) => a + (t - mean) ** 2, 0) / (n - 1) : 0;
  const std = Math.sqrt(variance);
  return { count: n, meanMs: mean, variance, stdMs: std, cv: mean > 0 ? std / mean : 0 };
}

/** Agrégats par joueur. */
export function aggregatePlayers(req: AnalysisRequest, moves: MoveAnalysis[]): PlayerAnalysis[] {
  return (["w", "b"] as const).map((color) => {
    const mine = moves.filter((m) => m.color === color && m.included);
    const n = mine.length;
    // temps : coups retenus ET chronométrés (les 2 premiers demi-coups ne le sont pas)
    const t = timeStats(mine.filter((m) => m.ply >= 2).map((m) => m.timeMs));
    return {
      userId: req.players[color].userId,
      color,
      rating: req.players[color].rating,
      analysedMoves: n,
      acpl: n ? round(mine.reduce((a, m) => a + m.cpLoss, 0) / n, 2) : 0,
      engineMatchRate: n ? round(mine.filter((m) => m.matched).length / n, 4) : 0,
      timeMeanMs: round(t.meanMs, 1),
      timeVariance: round(t.variance, 1),
      timeCv: round(t.cv, 4),
      focusLoss: req.focusLoss[color],
    };
  });
}

/** Analyse complète d'une partie avec un évaluateur (moteur réel ou simulé). */
export async function analyseGame(req: AnalysisRequest, evaluate: Evaluator, cfg: MetricsConfig = DEFAULT_METRICS) {
  const { positions, moves } = replay(req.pgn);
  const evals = await evaluatePositions(positions, evaluate);
  const analyses = computeMoveAnalyses(moves, positions, evals, req.moveTimesMs, cfg);
  return { moves: analyses, players: aggregatePlayers(req, analyses) };
}
