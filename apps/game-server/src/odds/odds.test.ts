import { describe, expect, it } from "vitest";
import { humanWdl, oddsFromWdl, outcomeOf, payoutOf, probabilities, wdlForWhite } from "./odds.js";

describe("cotes en direct", () => {
  it("position d'élite équilibrée : la nulle est favorite, cotes avec marge de 6 %", () => {
    const { odds, suspended, probs } = oddsFromWdl({ w: 150, d: 750, l: 100 });
    expect(suspended).toBe(false);
    expect(probs.draw).toBeCloseTo(0.75, 3);
    expect(odds).toEqual({ white: 6.28, draw: 1.25, black: 9.43 });
    // marge : la somme des probabilités implicites dépasse 1
    const implied = 1 / odds.white + 1 / odds.draw + 1 / odds.black;
    expect(implied).toBeGreaterThan(1.05);
    expect(implied).toBeLessThan(1.08);
  });
  it("issue quasi certaine : marché suspendu ; plancher de 1 % (cote max 30)", () => {
    const r = oddsFromWdl({ w: 990, d: 10, l: 0 });
    expect(r.suspended).toBe(true);
    expect(r.odds.black).toBe(30);
    expect(r.odds.white).toBe(1.01);
    expect(probabilities({ w: 0, d: 0, l: 1000 }).white).toBeCloseTo(10 / 1020, 6);
  });
  it("WDL du camp au trait → point de vue des Blancs ; résultat → issue ; gain", () => {
    expect(wdlForWhite({ w: 600, d: 300, l: 100 }, "b")).toEqual({ w: 100, d: 300, l: 600 });
    expect([outcomeOf("1-0"), outcomeOf("0-1"), outcomeOf("1/2-1/2"), outcomeOf("*"), outcomeOf(null)]).toEqual(["white", "black", "draw", null, null]);
    expect(payoutOf(1000, 2.35)).toBe(2350);
  });
});

describe("modèle humain (évaluation → victoire / nulle / défaite)", () => {
  it("égalité : beaucoup de nulles ; +1 pion : les Blancs favoris ; +5 : quasi gagné ; mat : certain ; symétrique", () => {
    const eq = humanWdl(0);
    expect(eq).toEqual({ w: 225, d: 550, l: 225 });
    const pawn = humanWdl(100);
    expect(pawn.w).toBeGreaterThan(pawn.l * 1.5);
    expect(pawn.d).toBeLessThan(eq.d);
    expect(humanWdl(500).w).toBeGreaterThan(850);
    expect(humanWdl(10_000)).toEqual({ w: 1000, d: 0, l: 0 });
    expect(humanWdl(-120)).toEqual({ w: humanWdl(120).l, d: humanWdl(120).d, l: humanWdl(120).w });
    for (const cp of [-800, -200, 0, 37, 300, 2000]) { const x = humanWdl(cp); expect(x.w + x.d + x.l).toBeGreaterThanOrEqual(999); expect(Math.min(x.w, x.d, x.l)).toBeGreaterThanOrEqual(0); }
    // 1.e4 e5 (+30) : cotes raisonnables pour un match d'élite
    const o = oddsFromWdl(humanWdl(30)).odds;
    expect(o.white).toBeGreaterThan(3); expect(o.white).toBeLessThan(4.5);
    expect(o.draw).toBeGreaterThan(1.6); expect(o.draw).toBeLessThan(2);
  });
});
