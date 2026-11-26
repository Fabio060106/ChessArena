import { describe, expect, it } from "vitest";
import type { RepertoireGame } from "@chessarena/shared";
import { buildProfile, CATALOG, recommend, ucisOf } from "./openingAdvisor";

let k = 0;
function game(color: "w" | "b", outcome: "win" | "loss" | "draw", opening: string, moves: string, elo = 1300): RepertoireGame {
  const sans = moves.split(" ");
  const body = sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${s}` : s)).join(" ");
  const res = outcome === "draw" ? "1/2-1/2" : (outcome === "win") === (color === "w") ? "1-0" : "0-1";
  const pgn = `[White "${color === "w" ? "Moi" : "Adv"}"]\n[Black "${color === "b" ? "Moi" : "Adv"}"]\n[Result "${res}"]\n[${color === "w" ? "WhiteElo" : "BlackElo"} "${elo}"]\n[Opening "${opening}"]\n\n${body} ${res}\n`;
  return { gameId: `g${k++}`, endedAt: new Date(Date.UTC(2026, 9, 1) + k * 3600_000).toISOString(), color, opponent: "Adv", outcome, timeControl: "blitz_3_0", pgn, source: "lichess" };
}
const ITA = "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O O-O";
const SIC = "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6";
const QGD = "d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7";

describe("conseiller d'ouvertures", () => {
  // joueur 1300 : gagne avec l'Italienne, perd souvent vite en Sicilienne avec les Noirs
  const games = [
    ...Array.from({ length: 6 }, (_, i) => game("w", i < 5 ? "win" : "loss", "Italian Game: Giuoco Pianissimo", ITA)),
    ...Array.from({ length: 6 }, (_, i) => game("b", i < 1 ? "win" : "loss", "Sicilian Defense: Najdorf Variation", SIC)),
    ...Array.from({ length: 4 }, () => game("b", "draw", "Queen's Gambit Declined", QGD)),
  ];
  const p = buildProfile(games);

  it("profil : niveau, scores, forces et faiblesses", () => {
    expect(p).toMatchObject({ games: 16, rating: 1300, level: "intermédiaire" });
    expect(p.score.w).toBe(83);
    expect(p.vsE4).toEqual({ games: 6, score: 17 });
    expect(p.strengths.join(" ")).toMatch(/Parties en Italian Game, avec les Blancs : 83 % sur 6 parties/);
    expect(p.weaknesses.join(" ")).toMatch(/Parties en Sicilian Defense, avec les Noirs : seulement 17 %/);
    expect(p.weaknesses.join(" ")).toMatch(/avant le 25e coup/);
  });
  it("recommandations : garder ce qui marche, remplacer ce qui perd, adapté au niveau", () => {
    const w = recommend(p, "w");
    expect(w[0]!.option.id).toBe("italian");
    expect(w[0]!.reasons[0]).toMatch(/tu la joues déjà avec succès \(83 %/);
    const e4 = recommend(p, "b-e4");
    expect(e4.map((a) => a.option.id)).not.toContain("sicilian");
    expect(e4.every((a) => a.option.solid)).toBe(true);
    const d4 = recommend(p, "b-d4");
    expect(d4.map((a) => a.option.id)).not.toContain("kid");
    expect(d4.map((a) => a.option.id)).not.toContain("nimzo");
  });
  it("chaque ligne du catalogue est jouable", () => {
    for (const o of CATALOG) expect(ucisOf(o.moves).length).toBe(o.moves.split(" ").length);
  });
});
