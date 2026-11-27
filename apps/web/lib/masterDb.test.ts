import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { splitPgnGames } from "@chessarena/shared";
import { MasterBuilder, masterMovesOf, scoreFor, shardOf, type MasterGame, type MasterStatRow } from "./masterDb";
import { epdOf } from "./openingBook";

const game = (w: string, b: string, we: number, be: number, date: string, r: string, moves: string) =>
  `[White "${w}"]\n[Black "${b}"]\n[WhiteElo "${we}"]\n[BlackElo "${be}"]\n[Date "${date}"]\n[Result "${r}"]\n[Annotator "X"]\n\n${moves} ${r}\n\n`;
const PGN = [
  game("A", "B", 2700, 2650, "2020.01.01", "1-0", "1. e4 {commentaire} e5 2. Nf3 (2. f4) Nc6 3. Bb5 a6"),
  game("C", "D", 2600, 2500, "2021.01.01", "0-1", "1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6"),
  game("E", "F", 2400, 2450, "2015.01.01", "1/2-1/2", "1. e4 c5 2. Nf3 d6"),
  game("G", "H", 1800, 2600, "2022.01.01", "1-0", "1. d4 d5"),
  game("I", "J", 2500, 2500, "2023.01.01", "1-0", "1. d4 Nf6 2. c4 e6"),
].join("");
const epdAfter = (s: string) => { const c = new Chess(); for (const m of s.split(" ")) c.move(m); return epdOf(c.fen()); };

describe("base de maîtres", () => {
  it("répartit les positions entre 256 fichiers, de façon stable", () => {
    const a = shardOf(epdOf(new Chess().fen()));
    expect(a).toMatch(/^[0-9a-f]{2}$/);
    expect(shardOf(epdOf(new Chess().fen()))).toBe(a);
  });

  it("compte les coups par position, écarte les parties trop faibles, garde des parties modèles sans commentaires", () => {
    const b = new MasterBuilder({ minElo: 2200, maxPly: 10, minGames: 1, models: 2, targets: [{ rep: "ruy", line: "Ruy", epd: epdAfter("e4 e5 Nf3 Nc6 Bb5"), ply: 5 }] });
    let kept = 0;
    for (const g of splitPgnGames(PGN)) if (b.add(g)) kept++;
    expect(kept).toBe(4); // la partie à 1800 est écartée
    const files = b.finish("test");
    const start = epdOf(new Chess().fen());
    const shard = files.get(`s/${shardOf(start)}.json`) as Record<string, MasterStatRow[]>;
    const rows = shard[start]!;
    expect(rows[0]).toEqual(["e2e4", 3, 1, 1, 1, 2550, 2021]);
    expect(rows[1]![0]).toBe("d2d4");
    const moves = masterMovesOf(new Chess().fen(), rows);
    expect(moves[0]).toMatchObject({ san: "e4", games: 3, share: 75 });
    expect(scoreFor(moves[1]!, "w")).toBe(100);
    // la variante 2.f4 du commentateur n'est pas comptée
    const afterE5 = epdAfter("e4 e5");
    const s2 = files.get(`s/${shardOf(afterE5)}.json`) as Record<string, MasterStatRow[]>;
    expect(s2[afterE5]!.map((r) => r[0])).toEqual(["g1f3"]);
    const models = files.get("models/ruy.json") as Record<string, MasterGame[]>;
    expect(models.Ruy!.map((g) => g.w)).toEqual(["A", "C"]);
    expect(JSON.stringify(models)).not.toContain("commentaire");
    expect(models.Ruy![0]!.m).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]);
    expect(files.get("meta.json")).toMatchObject({ games: 4, years: [2015, 2023], source: "test" });
  });

  it("n'écrit que les positions assez jouées", () => {
    const b = new MasterBuilder({ minElo: 0, maxPly: 10, minGames: 3, models: 2 });
    for (const g of splitPgnGames(PGN)) b.add(g);
    const files = b.finish("test");
    const all = [...files.entries()].filter(([k]) => k.startsWith("s/")).flatMap(([, v]) => Object.keys(v as object));
    expect(all).toContain(epdOf(new Chess().fen()));
    expect(all).not.toContain(epdAfter("e4 c5"));
  });
});
