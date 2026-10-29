import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, evaluatePlayer, slidingHoldFlags, type GameStat } from "./rules.js";

let n = 0;
const g = (p: Partial<GameStat> = {}): GameStat => ({
  gameId: `g${++n}`, endedAt: new Date(2026, 9, 1, 0, n).toISOString(), depth: 18, rating: 1500,
  analysedMoves: 25, acpl: 6, engineMatchRate: 0.85, timeCv: 0.8, focusLoss: 0, ...p,
});

describe("règle de blocage (WITHDRAWAL_HOLD)", () => {
  it("ACPL < 10 sur 3 parties + coïncidence ≥ 80 % + Elo < 2000 + analyses profondes → HOLD", () => {
    const o = evaluatePlayer([g(), g(), g()]);
    expect(o.verdict).toBe("HOLD");
    expect(o.windowGameIds).toHaveLength(3);
    expect(o.pooledMatchRate).toBeCloseTo(0.85);
  });

  it("une seule partie à ACPL = 10 (limite stricte) suffit à empêcher le blocage", () => {
    expect(evaluatePlayer([g(), g({ acpl: 10 }), g()]).verdict).not.toBe("HOLD");
  });

  it("coïncidence POOLÉE pondérée par le nombre de coups (pas moyenne de moyennes)", () => {
    // moyenne simple = (0.95 + 0.95 + 0.55)/3 = 0.817 ≥ 0.8 ; poolée = (19+19+33)/(20+20+60) = 0.71
    const games = [g({ analysedMoves: 20, engineMatchRate: 0.95 }), g({ analysedMoves: 20, engineMatchRate: 0.95 }), g({ analysedMoves: 60, engineMatchRate: 0.55 })];
    const o = evaluatePlayer(games);
    expect(o.pooledMatchRate).toBeCloseTo(0.71, 2);
    expect(o.verdict).not.toBe("HOLD");
  });

  it("ACPL bas SANS coïncidence moteur élevée : surveillance, pas de blocage", () => {
    expect(evaluatePlayer([g({ engineMatchRate: 0.6 }), g({ engineMatchRate: 0.6 }), g({ engineMatchRate: 0.6 })]).verdict).toBe("WATCH");
  });

  it("Elo ≥ 2000 : revue humaine (WATCH), jamais de blocage automatique", () => {
    const o = evaluatePlayer([g(), g(), g({ rating: 2000 })]);
    expect(o.verdict).toBe("WATCH");
    expect(o.reasons.join()).toMatch(/revue humaine/);
  });

  it("analyse de triage (profondeur 12) dans la fenêtre → CONFIRM et liste des parties à réanalyser", () => {
    const shallow = g({ depth: 12 });
    const o = evaluatePlayer([g(), shallow, g({ depth: 12 })]);
    expect(o.verdict).toBe("CONFIRM");
    expect(o.needsDeepAnalysis).toHaveLength(2);
    expect(o.needsDeepAnalysis[0]).toBe(shallow.gameId);
  });

  it("les parties trop courtes sont ignorées (ne cassent ni ne complètent la série)", () => {
    const short = g({ analysedMoves: 8, acpl: 80, engineMatchRate: 0.2 });
    expect(evaluatePlayer([g(), short, g(), g()]).verdict).toBe("HOLD");
    expect(evaluatePlayer([g(), g(), short]).verdict).toBe("CLEAN"); // seulement 2 éligibles
  });

  it("seules les 3 parties les plus récentes comptent", () => {
    expect(evaluatePlayer([g(), g(), g(), g({ acpl: 45, engineMatchRate: 0.5 })]).verdict).not.toBe("HOLD");
  });

  it("joueur honnête typique : CLEAN", () => {
    const o = evaluatePlayer([g({ acpl: 48, engineMatchRate: 0.52 }), g({ acpl: 61, engineMatchRate: 0.47 }), g({ acpl: 39, engineMatchRate: 0.55 })]);
    expect(o).toMatchObject({ verdict: "CLEAN", score: 0 });
  });

  it("signaux faibles cumulés (focus + temps réguliers) → score, sans blocage", () => {
    const o = evaluatePlayer([g({ acpl: 30, engineMatchRate: 0.82, focusLoss: 5, timeCv: 0.2 }), g({ acpl: 30, engineMatchRate: 0.82, focusLoss: 5, timeCv: 0.2 }), g({ acpl: 30, engineMatchRate: 0.82, focusLoss: 5, timeCv: 0.2 })]);
    expect(o.verdict).toBe("WATCH");
    expect(o.score).toBe(60);
  });

  it("fenêtres glissantes (calibration)", () => {
    const hist = [g({ acpl: 40 }), g(), g(), g(), g({ acpl: 40 })];
    expect(slidingHoldFlags(hist)).toEqual([false, true, false]);
    expect(DEFAULT_RULES).toMatchObject({ window: 3, acplMax: 10, matchMin: 0.8, ratingCeiling: 2000 });
  });
});
