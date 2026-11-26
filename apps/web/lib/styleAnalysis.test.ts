import { describe, expect, it } from "vitest";
import type { RepertoireGame } from "@chessarena/shared";
import { buildStyle, deepAnalyse, structureOf } from "./styleAnalysis";
import { buildProfile, recommend } from "./openingAdvisor";

let k = 0;
function game(color: "w" | "b", outcome: "win" | "loss" | "draw", moves: string): RepertoireGame {
  const sans = moves.split(" ");
  const body = sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${s}` : s)).join(" ");
  const res = outcome === "draw" ? "1/2-1/2" : (outcome === "win") === (color === "w") ? "1-0" : "0-1";
  return { gameId: `s${k++}`, endedAt: new Date(Date.UTC(2026, 9, 1) + k * 3600_000).toISOString(), color, opponent: "X", outcome, timeControl: "blitz_3_0", pgn: `[Result "${res}"]\n\n${body} ${res}\n` };
}
// centre ouvert (Écossaise : pions d et e échangés) / centre fermé (Française d'avance)
const OPEN = "e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nxc6 bxc6 Bd3 d5 exd5 cxd5 O-O Be7 Nc3 O-O Bg5 c6 Qf3 Rb8 Rab1 Be6";
const CLOSED = "e4 e6 d4 d5 e5 c5 c3 Nc6 Nf3 Qb6 a3 c4 Nbd2 Na5 Be2 Bd7 O-O Ne7 Rb1 Nc8 Re1 Be7 Nf1 O-O";

describe("style de jeu", () => {
  it("structures : ouvert, fermé", () => {
    const fen = (m: string) => { const g = game("w", "win", m); const { Chess } = require("chess.js"); const c = new Chess(); c.loadPgn(g.pgn); return c.fen(); };
    expect(structureOf(fen(OPEN))).toBe("open");
    expect(structureOf(fen(CLOSED))).toBe("closed");
  });
  const games = [
    ...Array.from({ length: 8 }, (_, i) => game("w", i < 6 ? "win" : "draw", OPEN)),
    ...Array.from({ length: 8 }, (_, i) => game("w", i < 6 ? "loss" : "draw", CLOSED)),
  ];
  const st = buildStyle(games);
  it("scores par structure et constat", () => {
    expect(st.structures.open).toEqual({ games: 8, score: 88 });
    expect(st.structures.closed).toEqual({ games: 8, score: 13 });
    expect(st.findings[0]).toMatch(/Tu marques 88 % quand le centre est ouvert, contre 13 %/);
  });
  it("les ouvertures conseillées suivent le style : positions ouvertes", () => {
    const w = recommend(buildProfile(games), "w", 2, st);
    expect(["scotch", "evans", "kgambit"]).toContain(w[0]!.option.id);
    expect(w[0]!.reasons.join(" ")).toMatch(/positions ouvertes, où tu marques 88 %/);
    expect(w.map((a) => a.option.id)).not.toContain("london");
  });
  it("analyse approfondie : erreurs par phase et conversion", async () => {
    // faux moteur : les Blancs ont +5 jusqu'au 20e demi-coup puis la position s'égalise → avantage non converti
    let n = 0;
    const deep = await deepAnalyse(games.slice(8, 12), async () => {
      const i = n++ % 25;
      return { depth: 8, score: { cp: i < 20 ? 500 : 0, mate: null }, pv: [] };
    });
    expect(deep).toMatchObject({ games: 4, winning: 4, notConverted: 4 });
    expect(deep!.loss.opening).not.toBeNull();
    const st2 = buildStyle(games, deep);
    expect(st2.axes.find((a) => a.id === "opening")!.value).not.toBeNull();
    expect(st2.findings.join(" ")).toMatch(/laissé échapper 4 parties gagnantes sur 4/);
  });
});
