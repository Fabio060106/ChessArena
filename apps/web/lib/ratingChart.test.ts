import { describe, expect, it } from "vitest";
import { chartGeometry, chartSummary, nearestIndex } from "./ratingChart";

const pts = (...r: number[]) => r.map((rating, i) => ({ at: new Date(2026, 10, i + 1).toISOString(), rating }));

describe("courbe d'Elo", () => {
  it("moins de deux parties : pas de courbe", () => {
    expect(chartGeometry(pts(1500), 300, 100)).toBeNull();
  });
  it("bornes arrondies avec marge, du premier au dernier point sur toute la largeur", () => {
    const g = chartGeometry(pts(1520, 1480, 1561), 300, 100)!;
    expect([g.min, g.max]).toEqual([1470, 1580]);
    expect(g.xy[0]!.x).toBe(0);
    expect(g.xy[2]!.x).toBe(300);
    expect(g.xy[1]!.y).toBeGreaterThan(g.xy[0]!.y); // plus bas = Elo plus faible
    expect(g.line.startsWith("M0,")).toBe(true);
    expect(g.ticks.length).toBeGreaterThan(1);
    expect(g.ticks.every((t) => t >= g.min && t <= g.max && t % 25 === 0)).toBe(true);
  });
  it("Elo stable : amplitude minimale de 40 points (pas de courbe écrasée)", () => {
    const g = chartGeometry(pts(1500, 1500, 1500), 300, 100)!;
    expect(g.max - g.min).toBe(40);
    expect(g.xy.every((q) => q.y === g.xy[0]!.y)).toBe(true);
  });
  it("survol : point le plus proche ; résumé de la période", () => {
    expect([nearestIndex(5, 0, 400), nearestIndex(5, 160, 400), nearestIndex(5, 999, 400)]).toEqual([0, 2, 4]);
    expect(chartSummary(pts(1500, 1540, 1510))).toEqual({ first: 1500, last: 1510, delta: 10, best: 1540 });
    expect(chartSummary([])).toBeNull();
  });
});
