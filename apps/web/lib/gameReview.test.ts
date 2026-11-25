import { describe, expect, it } from "vitest";
import { buildReview, type PositionEval } from "./gameReview";
import { replayFromSans } from "./replay";

const ev = (cp: number, pv: string[] = []): PositionEval => ({ score: { cp, mate: null }, pv });

describe("analyse d'après-partie", () => {
  it("repère la gaffe, propose le meilleur coup, calcule la précision et résume", () => {
    const sans = ["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6", "Qxf7#"];
    const fens = replayFromSans(sans).map((s) => s.fen);
    const evals = [ev(20), ev(30), ev(10), ev(20), ev(30), ev(30, ["d8e7"]), ev(900), { score: { cp: 10_000, mate: null }, pv: [] }];
    const r = buildReview({ sans, fens, evals, names: { w: "Gukesh", b: "Sindarov" }, result: "1-0" });
    expect(r.counts.b["??"]).toBe(1);
    const blunder = r.moments.find((m) => m.mark === "??")!;
    expect(blunder).toMatchObject({ ply: 6, mover: "b", move: "3… Nf6" });
    expect(blunder.best).toBe("Qe7");
    expect(blunder.text).toMatch(/Sindarov commet une gaffe.*Il fallait Qe7/);
    expect(r.accuracy.w).toBeGreaterThan(r.accuracy.b!);
    expect(r.curve).toHaveLength(8);
    expect(r.summary).toMatch(/^Victoire de Gukesh en 4 coups\./);
    expect(r.summary).toMatch(/Tournant de la partie : 3… Nf6\?\?/);
  });
  it("nulle sans erreur, avantage non concrétisé", () => {
    const sans = ["d4", "d5", "c4", "e6"];
    const fens = replayFromSans(sans).map((s) => s.fen);
    const r = buildReview({ sans, fens, evals: [ev(20), ev(60), ev(100), ev(140), ev(180)], names: { w: "A", b: "B" }, result: "1/2-1/2" });
    expect(r.moments).toEqual([]);
    expect(r.summary).toMatch(/Nulle en 2 coups/);
    expect(r.summary).toMatch(/Aucune vraie erreur/);
    expect(r.summary).toMatch(/A a eu un net avantage \(\+1,8\) sans réussir à le concrétiser/);
  });
});
