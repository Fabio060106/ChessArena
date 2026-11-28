import { describe, expect, it } from "vitest";
import { arenaPairs, arenaRanking, arenaScores, teamStandings, type ArenaGame } from "./arena.js";

describe("Arena — points et séries", () => {
  it("victoire 2, nulle 1 ; après deux victoires de suite, en feu : victoire 4, nulle 2 ; la série s'arrête à la première non-victoire", () => {
    const g = (white: string, black: string, result: ArenaGame["result"]): ArenaGame => ({ white, black, result });
    const s = arenaScores(["a", "b"], [
      g("a", "b", "1-0"), g("b", "a", "0-1"), // a : 2, 2 → en feu
      g("a", "b", "1-0"), // 4
      g("b", "a", "1/2-1/2"), // a en feu : nulle 2, série finie
      g("a", "b", "1-0"), // 2
    ]).get("a")!;
    expect(s.sheet).toEqual([2, 2, 4, 2, 2]);
    expect(s.score).toBe(12);
    expect(s.fire).toBe(false);
    expect(s.wins).toBe(4);
  });

  it("en feu après deux victoires (affiché), forfait : 0 pour le responsable, rien pour l'autre", () => {
    const s = arenaScores(["a", "b", "c"], [
      { white: "a", black: "b", result: "1-0" }, { white: "c", black: "a", result: "0-1" },
      { white: "b", black: "a", result: "forfeit-w" }, // b n'a pas joué : a ne perd pas sa série
    ]);
    expect(s.get("a")).toMatchObject({ score: 4, fire: true, games: 2 });
    expect(s.get("b")).toMatchObject({ score: 0, sheet: [0, 0], games: 2 });
    // la série de a continue : prochaine victoire = 4
    const s2 = arenaScores(["a", "b", "c"], [
      { white: "a", black: "b", result: "1-0" }, { white: "c", black: "a", result: "0-1" },
      { white: "b", black: "a", result: "forfeit-w" }, { white: "a", black: "c", result: "1-0" },
    ]);
    expect(s2.get("a")!.sheet).toEqual([2, 2, 4]);
  });

  it("classement : score, puis victoires, puis moins de parties, puis Elo", () => {
    const s = arenaScores(["a", "b", "c", "d"], [
      { white: "a", black: "b", result: "1-0" }, { white: "c", black: "d", result: "1/2-1/2" }, { white: "d", black: "c", result: "1/2-1/2" },
    ]);
    // a : 2 pts en 1 partie ; c et d : 2 pts en 2 parties (0 victoire) ; b : 0
    expect(arenaRanking(s, new Map([["c", 1400], ["d", 1600]]))).toEqual(["a", "d", "c", "b"]);
  });
});

describe("Arena — appariements", () => {
  const w = (id: string, score: number, rating = 1500, lastOpponent: string | null = null, whites = 0, blacks = 0) => ({ id, score, rating, lastOpponent, whites, blacks });

  it("voisins de classement, couleurs équilibrées", () => {
    const pairs = arenaPairs([w("a", 10, 1500, null, 2, 0), w("b", 9), w("c", 2), w("d", 1)], () => 0.9);
    expect(pairs.map((p) => p.slice().sort().join("-"))).toEqual(["a-b", "c-d"]);
    expect(pairs[0]).toEqual(["b", "a"]); // a a déjà eu deux fois les Blancs
  });

  it("évite de rejouer son dernier adversaire, sauf s'ils ne sont que deux à attendre", () => {
    expect(arenaPairs([w("a", 5, 1500, "b"), w("b", 5, 1500, "a"), w("c", 4)]).map((p) => p.slice().sort().join("-"))).toEqual(["a-c"]);
    expect(arenaPairs([w("a", 5, 1500, "b"), w("b", 5, 1500, "a")])).toHaveLength(1);
  });

  it("nombre impair : un joueur attend la prochaine vague", () => {
    expect(arenaPairs([w("a", 1), w("b", 1), w("c", 1)])).toHaveLength(1);
  });
});

describe("Arena — bataille de clubs", () => {
  const w = (id: string, score: number, team: string) => ({ id, score, rating: 1500, lastOpponent: null, whites: 0, blacks: 0, team });

  it("jamais deux joueurs du même club face à face (quitte à attendre la vague suivante)", () => {
    const pairs = arenaPairs([w("a1", 9, "A"), w("a2", 8, "A"), w("b1", 7, "B"), w("b2", 1, "B")], () => 0.4);
    for (const [x, y] of pairs) expect(x[0]).not.toBe(y[0]);
    expect(pairs).toHaveLength(2);
    expect(arenaPairs([w("a1", 9, "A"), w("a2", 8, "A")])).toHaveLength(0);
  });

  it("score d'un club : ses N meilleurs joueurs ; classement des clubs", () => {
    const scores = arenaScores(["a1", "a2", "a3", "b1"], [
      { white: "a1", black: "b1", result: "1-0" }, { white: "b1", black: "a2", result: "0-1" }, { white: "a3", black: "b1", result: "1/2-1/2" },
    ]);
    const teamOf = new Map([["a1", "A"], ["a2", "A"], ["a3", "A"], ["b1", "B"]]);
    const t = teamStandings(scores, teamOf, [{ slug: "B", name: "Club B" }, { slug: "A", name: "Club A" }], 2);
    expect(t.map((x) => [x.slug, x.score, x.players])).toEqual([["A", 4, 3], ["B", 1, 1]]); // A : 2 + 2 (le ½ de a3 ne compte pas, top 2)
    expect(t[0]!.top.map((x) => x.userId)).toEqual(["a1", "a2"]);
  });
});
