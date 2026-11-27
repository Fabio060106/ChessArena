import { describe, expect, it } from "vitest";
import type { RepertoireGame } from "@chessarena/shared";
import { repertoireById, type RepertoireDef } from "./repertoireBook";
import { buildExercises, buildTree, compareGames, learningPlan } from "./repertoireStudy";

const caro = repertoireById("caro")!;
const tree = buildTree([caro]);
const g = (moves: string, outcome: "win" | "loss" | "draw" = "win", color: "w" | "b" = "b"): RepertoireGame => {
  const sans = moves.split(" ");
  return { gameId: moves, endedAt: "2026-11-01T00:00:00Z", color, opponent: "X", outcome, timeControl: "blitz_3_0", pgn: sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${s}` : s)).join(" ") + " *" };
};

describe("étude d'un répertoire", () => {
  it("exercices : positions où trouver le coup du répertoire", () => {
    const ex = buildExercises(caro, tree);
    expect(ex.length).toBeGreaterThanOrEqual(6);
    for (const e of ex) expect(e.answers.length).toBeGreaterThan(0);
    expect(ex.some((e) => e.answerSan === "Bf5")).toBe(true);
  });
  it("comparaison avec les parties : sorties du joueur, coups adverses non couverts, autres ouvertures", () => {
    const r = compareGames(caro, tree, [
      g("e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2 c5"), // suit le répertoire
      g("e4 c6 d4 d5 e5 c5", "loss"), // le joueur sort : 3…c5 au lieu de 3…Bf5
      g("e4 c6 d4 d5 e5 c5", "loss"),
      g("e4 c6 c4 d5", "draw"), // l'adversaire joue 2.c4 (non couvert)
      g("e4 e5 Nf3 Nc6"), // autre ouverture
      g("d4 d5", "win", "w"), // pas la bonne couleur
      g("d4 d5", "win", "b"), // 1.d4 : hors du répertoire contre 1.e4
    ]);
    expect(r).toMatchObject({ games: 4, followed: 1, followedScore: 100, mineScore: 0, elsewhere: 1 });
    expect(r.mine[0]).toMatchObject({ played: "c5", expected: ["Bf5"], count: 2, before: "1.e4 c6 2.d4 d5 3.e5" });
    expect(r.theirs[0]).toMatchObject({ played: "c4", count: 1 });
  });
  it("plan d'apprentissage : nouvelle ouverture ou ouverture à garder", () => {
    expect(learningPlan(caro, "new", null, 0)[0]!.title).toMatch(/Comprendre/);
    const keep = learningPlan(caro as RepertoireDef, "keep", compareGames(caro, tree, [g("e4 c6 d4 d5 e5 c5", "loss")]), 0);
    expect(keep[0]!.text).toMatch(/tu joues c5 au lieu de Bf5/);
  });
});
