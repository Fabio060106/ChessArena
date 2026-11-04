import { describe, expect, it } from "vitest";
import { accuracy, classify, formatScore, parseInfo, pvToSan, scoreToCp, terminalScore, winPct } from "./engine";
import { replayFromSans } from "./replay";

describe("analyse Stockfish", () => {
  it("lit une ligne info UCI et ramène le score au point de vue des Blancs", () => {
    const l = "info depth 14 seldepth 20 multipv 1 score cp 35 nodes 123 nps 1 time 9 pv e2e4 e7e5 g1f3";
    expect(parseInfo(l, "w")).toEqual({ depth: 14, score: { cp: 35, mate: null }, pv: ["e2e4", "e7e5", "g1f3"] });
    expect(parseInfo(l, "b")!.score.cp).toBe(-35);
    expect(parseInfo("info depth 9 score mate 2 pv d1h5", "b")!.score.mate).toBe(-2);
    expect(parseInfo("info depth 3 currmove e2e4 currmovenumber 1", "w")).toBeNull();
    expect(parseInfo("info depth 14 multipv 2 score cp 1 pv a2a3", "w")).toBeNull();
  });

  it("affiche les évaluations à la française", () => {
    expect(formatScore({ cp: 142, mate: null })).toBe("+1,4");
    expect(formatScore({ cp: -30, mate: null })).toBe("−0,3");
    expect(formatScore({ cp: null, mate: 3 })).toBe("M3");
    expect(formatScore({ cp: null, mate: -2 })).toBe("−M2");
    expect(formatScore({ cp: 0, mate: null })).toBe("0,0");
  });

  it("classe les coups selon la perte de chances de gain (?! ? ??)", () => {
    expect(winPct(0)).toBe(50);
    expect(classify(30, 20, "w")).toBeNull();
    expect(classify(0, -250, "w")).toBe("?");
    expect(classify(0, -900, "w")).toBe("??");
    expect(classify(0, 900, "b")).toBe("??"); // les Noirs donnent l'avantage aux Blancs
    expect(classify(0, -900, "b")).toBeNull();
    expect(classify(scoreToCp({ cp: null, mate: 2 }), 0, "w")).toBe("??"); // mat manqué
  });

  it("précision : 100 % sans perte, nettement moins avec une gaffe", () => {
    expect(accuracy([0, 0, 0, 0, 0], "w")).toBe(100);
    expect(accuracy([0, 0, -900, -900], "b")).toBe(100);
    expect(accuracy([0, -900, -900], "w")!).toBeLessThan(30);
  });

  it("ligne principale en notation algébrique et positions terminales", () => {
    expect(pvToSan("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", ["e2e4", "e7e5", "zzzz"])).toEqual(["e4", "e5"]);
    const mate = replayFromSans(["e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6", "Qxf7#"]).at(-1)!.fen;
    expect(terminalScore(mate)).toEqual({ cp: 10_000, mate: null });
    expect(formatScore(terminalScore(mate)!)).toBe("1-0");
  });
});

describe("navigation dans les coups", () => {
  it("rejoue les coups connus et s'arrête au premier coup inconnu", () => {
    const s = replayFromSans(["e4", "e5", null, "Nc6"]);
    expect(s).toHaveLength(3);
    expect(s[2]).toMatchObject({ san: "e5", uci: "e7e5" });
  });
});

import { finalFromPgn } from "./gameReducer";
describe("fin de partie", () => {
  it("le PGN final ajoute le coup de mat manquant à la liste", () => {
    const f = finalFromPgn('[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0', 6);
    expect(f.moves).toEqual(["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6", "Qxf7#"]);
    expect(f.lastMove).toBe("h5f7");
    expect(finalFromPgn("", 3)).toEqual({});
    expect(finalFromPgn("1. e4 e5", 5)).toEqual({});
  });
});
