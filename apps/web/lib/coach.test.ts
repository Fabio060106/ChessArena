import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OpeningBook } from "./openingBook";
import { coachAt, rankRepertoires, refRepertoire } from "./coach";
import { replayFromSans } from "./replay";

const book = new OpeningBook(JSON.parse(readFileSync(join(__dirname, "../public/opening-book.json"), "utf8")));
const lineOf = (m: string) => replayFromSans(m.split(" ")).slice(1).map((x) => ({ uci: x.uci!, san: x.san!, fen: x.fen }));

describe("le coach de l'arbre", () => {
  const ref = refRepertoire("caro")!;
  it("explique le dernier coup, nomme la variante, montre répertoire + théorie + parties", () => {
    const c = coachAt({ line: lineOf("e4 c6 d4 d5 e5"), color: "b", book, ref, userMoves: [{ uci: "c6c5", san: "c5", count: 3, points: 0.5, lastAt: "" }] });
    expect(c.name).toMatch(/Caro-Kann.*Advance/);
    expect(c.comment.join(" ")).toMatch(/On entre dans la défense Caro-Kann/);
    const bf5 = c.moves.find((m) => m.san === "Bf5")!;
    expect(bf5.rep.length).toBeGreaterThan(0);
    expect(c.moves[0]!.san).toBe("Bf5");
    expect(c.moves.find((m) => m.san === "c5")).toMatchObject({ games: { count: 3, score: 17 } });
    expect(c.moves.filter((m) => m.theory).length).toBeGreaterThanOrEqual(1);
    expect(c.leads.join(" ")).toMatch(/Tu joues surtout c5 ici, le répertoire de référence prévoit Bf5/);
    expect(c.notes.some((n) => /avance/i.test(n.line))).toBe(true);
  });
  it("ajoute les coups des maîtres et en tire une piste", () => {
    const master = [
      { uci: "c6c5", san: "c5", games: 300, share: 60, white: 40, draw: 30, black: 30, elo: 2600, year: 2024 },
      { uci: "c8f5", san: "Bf5", games: 180, share: 36, white: 35, draw: 40, black: 25, elo: 2580, year: 2023 },
      { uci: "h7h6", san: "h6", games: 5, share: 1, white: 60, draw: 20, black: 20, elo: 2300, year: 2001 },
    ];
    const c = coachAt({ line: lineOf("e4 c6 d4 d5 e5"), color: "b", book, ref, userMoves: [], master });
    expect(c.moves[0]!.san).toBe("Bf5");
    expect(c.moves.find((m) => m.san === "c5")!.master).toEqual({ games: 300, share: 60, score: 45, elo: 2600, year: 2024 });
    expect(c.moves.find((m) => m.san === "h6")).toBeUndefined(); // trop rare
    expect(c.leads.join(" ")).toMatch(/Les maîtres préfèrent c5 \(60 %, 45 % de score\) au Bf5 du répertoire/);
  });
  it("classe les répertoires selon les parties du joueur", () => {
    const played = new Set(replayFromSans("e4 c6 d4 d5 e5 Bf5".split(" ")).map((x) => x.fen.split(" ").slice(0, 4).join(" ")));
    expect(rankRepertoires("b", played)[0]!.id).toBe("caro");
  });
});
