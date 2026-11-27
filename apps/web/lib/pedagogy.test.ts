import { describe, expect, it } from "vitest";
import type { EngineLine } from "./engine";
import { OpeningBook } from "./openingBook";
import { buildTeaching, quizPrompt } from "./pedagogy";
import { openingIdea, openingOf } from "./openings";
import { replayFromSans } from "./replay";

const L = (cp: number, pv: string[]): EngineLine => ({ depth: 13, score: { cp, mate: null }, pv });
const M = (mate: number, pv: string[]): EngineLine => ({ depth: 13, score: { cp: null, mate }, pv });

describe("ouvertures", () => {
  it("la plus longue correspondance", () => {
    expect(openingOf("e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 Re1".split(" "))).toEqual({ name: "Défense berlinoise, variante ouverte", plies: 8 });
    expect(openingOf("e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4 Nd6 Bxc6 dxc6 dxe5 Nf5 Qxd8+ Kxd8".split(" ")).name).toBe("Défense berlinoise (variante du « mur de Berlin »)");
    expect(openingIdea("Défense berlinoise, variante ouverte")).toMatch(/contre-attaquent/);
    expect(openingOf("d4 Nf6 c4 e6 g3 d5".split(" ")).name).toBe("Ouverture catalane");
    expect(openingOf(["a3"]).name).toBeNull();
  });
});

describe("analyse pédagogique", () => {
  // 1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6?? 4. Qxf7#
  const sans = ["e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6", "Qxf7#"];
  const steps = replayFromSans(sans);
  const fens = steps.map((s) => s.fen);
  const ucis = steps.slice(1).map((s) => s.uci!);
  const lines: EngineLine[][] = [
    [L(30, ["e2e4"]), L(25, ["d2d4"])],
    [L(30, ["e7e5"]), L(35, ["c7c5"])],
    [L(25, ["g1f3"]), L(20, ["f1c4"])],
    [L(30, ["b8c6"]), L(28, ["g8f6"])],
    [L(10, ["g1f3"]), L(5, ["d1h5"])],
    [L(0, ["g7g6", "h5f3", "g8f6"]), L(60, ["d8e7"]), L(400, ["g8f6", "h5f7"])],
    [M(1, ["h5f7"]), L(50, ["d2d3"])],
    [{ depth: 0, score: { cp: 10_000, mate: null }, pv: [] }],
  ];
  const r = buildTeaching({ sans, ucis, fens, lines, names: { w: "Gukesh", b: "Sindarov" }, result: "1-0" });

  it("un commentaire pour chaque coup", () => {
    expect(r.version).toBe(6);
    expect(r.moves).toHaveLength(7);
    expect(r.moves.map((m) => m.ply)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(r.moves[0]!.comment).toMatch(/Le pion occupe le centre en e4\. (Coup de théorie|C.est la position de référence)/);
    expect(r.moves[2]!.comment).toMatch(/Développement du fou en c4, vers le centre/);
    expect(r.moves.every((m) => m.comment.length > 5)).toBe(true);
  });
  it("la gaffe est expliquée : mat permis, avec la suite ; meilleure défense proposée", () => {
    const g = r.moves[5]!;
    expect(g).toMatchObject({ san: "Nf6", mark: "??", best: "g6" });
    expect(g.comment).toMatch(/^Une grave erreur des Noirs\. L'idée : développement du cavalier en f6.*Ce coup permet aux Blancs de mater en 1 : Qxf7#\. Il fallait jouer g6/);
    expect(g.alternatives.map((a) => a.san)).toEqual(["g6", "Qe7"]);
    expect(g.goodUcis).toEqual(["g7g6"]);
  });
  it("coup « ! » quand c'est le seul bon coup, et quiz", () => {
    expect(r.moves[6]).toMatchObject({ san: "Qxf7#", mark: "!" });
    expect(r.quiz).toEqual([6, 7]);
    expect(quizPrompt(r.moves[5]!, { w: "Gukesh", b: "Sindarov" })).toMatch(/Sindarov \(les Noirs\) s'est trompé ici\. Trouve un meilleur coup que Nf6/);
    expect(r.summary).toMatch(/^Partie italienne|^Ouverture du pion roi|^Partie ouverte/);
  });

  it("le cours : chapitres et leçons à retenir", () => {
    expect(r.lesson.chapters.map((c) => c.title)).toEqual(["L'ouverture", "Le tournant de la partie"]);
    expect(r.lesson.chapters[0]!.text).toMatch(/La partie commence par la partie italienne|Ouverture du pion roi|partie ouverte/i);
    expect(r.lesson.chapters[1]!.text).toMatch(/Le moment décisif est 3… Nf6\?\? des Noirs\..*Gukesh remporte la partie \(1-0\)/);
    expect(r.lesson.takeaways[0]).toMatch(/coups forcés/);
  });

  it("partie commentée façon livre : notes seulement sur les coups marquants, variante numérotée", () => {
    expect(r.moves.filter((m) => m.note).map((m) => m.san)).toEqual(["e5", "Nf6", "Qxf7#"]); // e5 : fin de la théorie reconnue
    expect(r.moves[5]!.note).toMatch(/^Une grave erreur des Noirs\..*mater en 1 : Qxf7#/);
    expect(r.moves[5]!.note).not.toMatch(/Il fallait jouer/);
    expect(r.moves[5]!.variation).toBe("3… g6 4. Qf3 Nf6, 0,0");
    expect(r.lesson.intro).toMatch(/^Gukesh \(Blancs\) contre Sindarov \(Noirs\)\./);
  });

  it("avec le livre d'ouvertures : variante exacte, sous-lignes à chaque coup, sortie de la théorie", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const book = new OpeningBook(JSON.parse(readFileSync(join(__dirname, "../public/opening-book.json"), "utf8")));
    const rb = buildTeaching({ sans, ucis, fens, lines, names: { w: "Gukesh", b: "Sindarov" }, result: "1-0", book });
    expect(rb.opening).toMatch(/^Partie italienne|^Ouverture du fou|^Partie du pion roi/);
    expect(rb.book?.plies[2]!.alternatives.map((a) => a.san)).toEqual(expect.arrayContaining(["Nf3", "Nc3"]));
    const n2 = rb.moves.filter((m) => m.note && /Autres sous-lignes connues/.test(m.note));
    expect(n2.length).toBeGreaterThan(0);
    expect(rb.lesson.intro).toMatch(/\([A-E]\d\d\)/);
  });

  it("pièce en prise repérée même si la meilleure réponse de l'adversaire est un autre coup gagnant", () => {
    // 1. e4 e5 2. Ba6?? : la meilleure réponse est un autre coup, la 2e (presque aussi forte) prend le fou
    const s2 = ["e4", "e5", "Ba6"];
    const st = replayFromSans(s2);
    const r2 = buildTeaching({
      sans: s2, ucis: st.slice(1).map((x) => x.uci!), fens: st.map((x) => x.fen), names: { w: "A", b: "B" }, result: null,
      lines: [[L(30, ["e2e4"])], [L(30, ["e7e5"])], [L(30, ["g1f3"]), L(0, ["b1c3"])], [L(-500, ["d7d5"]), L(-490, ["b8a6"]), L(0, ["g8f6"])]],
    });
    expect(r2.moves[2]!.mark).toBe("??");
    expect(r2.moves[2]!.comment).toMatch(/Le fou en a6 n'est plus assez protégé : Nxa6 le gagne/);
    expect(r2.moves[2]!.comment).toMatch(/Il fallait jouer Nf3, qui menaçait le pion e5|Il fallait jouer Nf3/);
  });
});

describe("base de maîtres dans les commentaires", () => {
  // 1.e4 e5 2.Nf3 Nc6 3.a3 Nf6 4.d3 d5
  const sans = ["e4", "e5", "Nf3", "Nc6", "a3", "Nf6", "d3", "d5"];
  const steps = replayFromSans(sans);
  const fens = steps.map((s) => s.fen);
  const ucis = steps.slice(1).map((s) => s.uci!);
  const lines: EngineLine[][] = [
    [L(30, ["e2e4"]), L(25, ["d2d4"])], [L(30, ["e7e5"]), L(35, ["c7c5"])], [L(25, ["g1f3"]), L(20, ["f1c4"])],
    [L(30, ["b8c6"]), L(28, ["g8f6"])], [L(30, ["f1b5"]), L(28, ["a2a3"])], [L(20, ["g8f6"]), L(22, ["f8c5"])],
    [L(20, ["d2d3"]), L(18, ["b1c3"])], [L(15, ["d7d5"]), L(14, ["f8c5"])], [L(15, ["e4d5"])],
  ];
  const mm = (rows: Array<[string, string, number]>) => {
    const total = rows.reduce((a, r) => a + r[2], 0);
    return rows.map(([uci, san, games]) => ({ uci, san, games, share: Math.round((100 * games) / total), white: 40, draw: 30, black: 30, elo: 2600, year: 2024 }));
  };
  const master = [
    mm([["e2e4", "e4", 500], ["d2d4", "d4", 400]]), mm([["e7e5", "e5", 300], ["c7c5", "c5", 200]]), mm([["g1f3", "Nf3", 280]]),
    mm([["b8c6", "Nc6", 250]]), mm([["f1b5", "Bb5", 120], ["f1c4", "Bc4", 80]]), [], [], [],
  ];
  it("signale la nouveauté : le premier coup absent de la base", () => {
    const r = buildTeaching({ sans, ucis, fens, lines, names: { w: "A", b: "B" }, result: null, master });
    const n = r.moves.find((m) => m.note?.startsWith("Nouveauté"));
    expect(n?.ply).toBe(5);
    expect(n!.note).toMatch(/aucune des 200 parties de maîtres.*Bb5 \(60 %\) ou Bc4 \(40 %\)/);
    expect(r.moves.filter((m) => m.note?.includes("Nouveauté"))).toHaveLength(1);
  });
  it("sans base de maîtres, pas de nouveauté annoncée", () => {
    const r = buildTeaching({ sans, ucis, fens, lines, names: { w: "A", b: "B" }, result: null });
    expect(r.moves.some((m) => m.note?.includes("Nouveauté"))).toBe(false);
  });
});
