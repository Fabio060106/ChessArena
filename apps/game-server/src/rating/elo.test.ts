import { describe, expect, it } from "vitest";
import { computeGameRatings, expectedScore, kFactor, nextState, ratingChange, type RatingState } from "./elo.js";

const st = (rating: number, games = 100, peak = rating): RatingState => ({ rating, games, peak });

describe("kFactor", () => {
  it("40 pour un nouveau compte (< 30 parties), quel que soit son niveau", () => {
    expect(kFactor(st(1500, 0))).toBe(40);
    expect(kFactor(st(2500, 29))).toBe(40);
  });
  it("20 pour un compte établi, 10 dès que 2400 a été atteint (même s'il redescend)", () => {
    expect(kFactor(st(1500, 30))).toBe(20);
    expect(kFactor(st(2399, 30))).toBe(20);
    expect(kFactor(st(2400, 30))).toBe(10);
    expect(kFactor(st(2350, 30, 2410))).toBe(10);
  });
});

describe("score attendu", () => {
  it("0,5 à égalité, symétrique, borné par la règle des 400 points", () => {
    expect(expectedScore(1500, 1500)).toBe(0.5);
    expect(expectedScore(1700, 1500) + expectedScore(1500, 1700)).toBeCloseTo(1, 12);
    expect(expectedScore(2400, 1000)).toBeCloseTo(expectedScore(1400, 1000), 12);
  });
});

describe("variations", () => {
  it("égalité, compte établi : ±10 (K=20)", () => {
    const r = computeGameRatings(st(1500), st(1500), 1);
    expect([r.white.delta, r.black.delta]).toEqual([10, -10]);
  });
  it("nouveau compte vs établi : chacun son K (somme non nulle, comme à la FIDE)", () => {
    const r = computeGameRatings(st(1500, 5), st(1500), 1);
    expect([r.white.delta, r.black.delta]).toEqual([20, -10]);
  });
  it("nulle contre plus fort : gain pour le plus faible", () => {
    const r = computeGameRatings(st(1400), st(1800), 0.5);
    expect(r.white.delta).toBeGreaterThan(0);
    expect(r.black.delta).toBeLessThan(0);
  });
  it("victoire attendue contre beaucoup plus faible : gain minimal mais positif (règle des 400)", () => {
    expect(ratingChange(st(2300), 1200, 1).delta).toBe(2); // 20 × (1 − 0,909) = 1,8 → 2
  });
  it("plancher à 100", () => {
    expect(ratingChange(st(105, 0), 105, 0).after).toBe(100);
  });
  it("nextState : compte les parties et mémorise le pic", () => {
    let s = st(2390, 40);
    s = nextState(s, ratingChange(s, 2390, 1)); // +10 (K=20)
    expect(s).toEqual({ rating: 2400, games: 41, peak: 2400 });
    expect(kFactor(s)).toBe(10);
  });
});
