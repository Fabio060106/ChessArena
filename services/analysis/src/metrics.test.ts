import { describe, expect, it, vi } from "vitest";
import type { AnalysisRequest, Color } from "@chessarena/shared";
import { aggregatePlayers, computeMoveAnalyses, DEFAULT_METRICS, evaluatePositions, replay, timeStats } from "./metrics.js";
import { MATE_CP, parseInfoScore, type EngineEval } from "./uci.js";

/** Partie synthétique : n demi-coups, évals et meilleurs coups maîtrisés (aucun moteur). */
function synthetic(n: number, opts: {
  evals?: (i: number) => number;          // éval de la position i, camp au trait
  best?: (i: number) => string;           // meilleur coup en position i
  legal?: (i: number) => number;
} = {}) {
  const moves = Array.from({ length: n }, (_, i) => ({ san: `m${i}`, uci: `a${i % 8 + 1}a${(i + 1) % 8 + 1}`, color: (i % 2 === 0 ? "w" : "b") as Color }));
  const positions = Array.from({ length: n + 1 }, (_, i) => ({ fen: `f${i}`, legal: opts.legal?.(i) ?? 20, terminal: null }));
  const evals: EngineEval[] = positions.map((_, i) => ({ cp: opts.evals?.(i) ?? 0, mate: null, bestMove: opts.best?.(i) ?? moves[i]?.uci ?? "(none)" }));
  return { moves, positions, evals };
}

const req = (moveTimesMs: number[], focus = { w: 0, b: 0 }): AnalysisRequest => ({
  gameId: "g", pgn: "", timeControl: "blitz_3_0", currency: "PLAY", moveTimesMs, focusLoss: focus,
  players: { w: { userId: "W", rating: 1500 }, b: { userId: "B", rating: 1600 } },
});

describe("parseInfoScore (UCI)", () => {
  it("centipions et mats, du point de vue du camp au trait", () => {
    expect(parseInfoScore("info depth 12 seldepth 14 multipv 1 score cp 18 nodes 1")).toEqual({ cp: 18, mate: null });
    expect(parseInfoScore("info depth 20 score cp -250 wdl 1 2 3")).toEqual({ cp: -250, mate: null });
    expect(parseInfoScore("info depth 9 score mate 3 nodes 4")).toEqual({ cp: MATE_CP - 3, mate: 3 });
    expect(parseInfoScore("info depth 9 score mate -2")).toEqual({ cp: -MATE_CP + 2, mate: -2 });
    expect(parseInfoScore("info string NNUE evaluation")).toBeNull();
  });
});

describe("perte par coup (centipawn loss)", () => {
  it("formule : éval avant (camp au trait) − éval après (même camp), jamais négative", () => {
    // ply 20 (Blancs) : +30 avant ; position suivante (Noirs au trait) +120 → −120 pour les Blancs
    const s = synthetic(30, { evals: (i) => (i === 20 ? 30 : i === 21 ? 120 : 0) });
    const a = computeMoveAnalyses(s.moves, s.positions, s.evals, []);
    expect(a[20]).toMatchObject({ cpLoss: 150, evalBeforeWhite: 30, evalAfterWhite: -120, included: true });
    // un coup qui AMÉLIORE l'éval (erreur de l'horizon du moteur) : perte 0, pas négative
    const g = synthetic(30, { evals: (i) => (i === 20 ? 0 : i === 21 ? -80 : 0) });
    expect(computeMoveAnalyses(g.moves, g.positions, g.evals, [])[20]!.cpLoss).toBe(0);
  });

  it("points de vue : les évals sont restituées côté Blancs pour la courbe", () => {
    const s = synthetic(30, { evals: (i) => (i === 21 ? 50 : i === 22 ? 10 : 0) }); // ply 21 = Noirs
    const m = computeMoveAnalyses(s.moves, s.positions, s.evals, [])[21]!;
    expect(m.color).toBe("b");
    expect(m.evalBeforeWhite).toBe(-50);
    expect(m.evalAfterWhite).toBe(10);
    expect(m.cpLoss).toBe(60); // Noirs : +50 avant, −10 après (de leur point de vue)
  });

  it("évals bornées à ±1000 : une gaffe isolée pèse au plus 2000", () => {
    const s = synthetic(30, { evals: (i) => (i === 20 ? 900 : i === 21 ? 5_000 : 0) });
    expect(computeMoveAnalyses(s.moves, s.positions, s.evals, [])[20]!.cpLoss).toBe(1900);
  });
});

describe("exclusions", () => {
  it("16 premiers demi-coups (ouverture)", () => {
    const s = synthetic(30, { evals: () => 0, best: () => "zzzz" });
    const a = computeMoveAnalyses(s.moves, s.positions, s.evals, []);
    expect(a.slice(0, 16).every((m) => m.excludedBy === "opening")).toBe(true);
    expect(a[16]!.included).toBe(true);
  });

  it("|éval| > 1000 avant le coup (partie décidée) ; 1000 pile reste inclus", () => {
    const s = synthetic(30, { evals: (i) => (i === 20 ? 1001 : i === 21 ? -1001 : i === 22 ? 1000 : 0) });
    const a = computeMoveAnalyses(s.moves, s.positions, s.evals, []);
    expect(a[20]!.excludedBy).toBe("extreme_eval");
    expect(a[21]!.excludedBy).toBe("extreme_eval");
    expect(a[22]!.included).toBe(true);
  });

  it("coup forcé (un seul coup légal)", () => {
    const s = synthetic(30, { legal: (i) => (i === 25 ? 1 : 20) });
    expect(computeMoveAnalyses(s.moves, s.positions, s.evals, [])[25]!.excludedBy).toBe("forced");
  });
});

describe("agrégats par joueur", () => {
  it("ACPL et coïncidence moteur calculés sur les seuls coups retenus", () => {
    // 40 demi-coups : Blancs plies 16..38 pairs = 12 coups retenus
    const s = synthetic(40, {
      evals: (i) => (i >= 16 && i % 2 === 0 ? 100 : i >= 17 && i % 2 === 1 ? -80 : 0), // perte Blancs = 100 − 80 = 20
      best: (i) => (i % 4 === 0 ? "best" : s0.moves[i]?.uci ?? "x"),                   // coïncidence 1 coup sur 2 pour les Blancs
      legal: () => 20,
    });
    const a = computeMoveAnalyses(s.moves, s.positions, s.evals, []);
    const [w] = aggregatePlayers(req([]), a);
    expect(w!.analysedMoves).toBe(12);
    expect(w!.acpl).toBe(20);
    expect(w!.engineMatchRate).toBe(0.5);
    // une perte énorme dans l'ouverture ne compte pas
    const opening = synthetic(40, { evals: (i) => (i === 2 ? 900 : 0) });
    expect(aggregatePlayers(req([]), computeMoveAnalyses(opening.moves, opening.positions, opening.evals, []))[0]!.acpl).toBe(0);
  });

  it("variance (n − 1), écart-type et coefficient de variation des temps", () => {
    expect(timeStats([1000, 2000, 3000])).toEqual({ count: 3, meanMs: 2000, variance: 1_000_000, stdMs: 1000, cv: 0.5 });
    expect(timeStats([])).toMatchObject({ count: 0, cv: 0 });
    expect(timeStats([1500])).toMatchObject({ variance: 0, cv: 0 });
  });

  it("temps : seuls les coups retenus du joueur ; focus repris de la requête", () => {
    const s = synthetic(24);
    const times = Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? [1000, 3000][(i / 2) % 2]! : 777));
    const [w, b] = aggregatePlayers(req(times, { w: 0, b: 5 }), computeMoveAnalyses(s.moves, s.positions, s.evals, times));
    expect(w).toMatchObject({ analysedMoves: 4, timeMeanMs: 2000, timeCv: 0.5774 });
    expect(b).toMatchObject({ timeMeanMs: 777, timeVariance: 0, timeCv: 0, focusLoss: 5 });
  });
});

describe("positions réelles", () => {
  it("rejoue un PGN, n'interroge pas le moteur sur une position de mat", async () => {
    const { positions, moves } = replay("1. f3 e5 2. g4 Qh4# 0-1");
    expect(moves.map((m) => m.uci)).toEqual(["f2f3", "e7e5", "g2g4", "d8h4"]);
    expect(positions).toHaveLength(5);
    expect(positions[4]!.terminal).toEqual({ cp: -MATE_CP, mate: 0, bestMove: "(none)" });
    const engine = vi.fn(async () => ({ cp: 0, mate: null, bestMove: "e2e4" }));
    const evals = await evaluatePositions(positions, engine);
    expect(engine).toHaveBeenCalledTimes(4);
    expect(evals[4]!.cp).toBe(-MATE_CP);
  });

  it("configuration par défaut conforme à la spécification", () => {
    expect(DEFAULT_METRICS).toEqual({ openingPlies: 16, extremeEvalCp: 1000, evalCap: 1000 });
  });
});

// utilisé par le test « agrégats » pour référencer les coups joués
const s0 = synthetic(40);
