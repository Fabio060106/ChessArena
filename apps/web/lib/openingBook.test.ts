import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OpeningBook, frenchOpening } from "./openingBook";
import { replayFromSans } from "./replay";

const book = new OpeningBook(JSON.parse(readFileSync(join(__dirname, "../public/opening-book.json"), "utf8")));
const trace = (moves: string) => {
  const st = replayFromSans(moves.split(" "));
  return book.trace(st.map((x) => x.fen), st.slice(1).map((x) => x.uci!));
};

describe("livre d'ouvertures", () => {
  it("contient les 3 865 positions nommées", () => expect(book.size).toBe(3865));
  it("nom exact de la variante, transpositions comprises", () => {
    const t = trace("e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4 Nd6 Bxc6 dxc6 dxe5 Nf5 Qxd8+ Kxd8 Nc3 Ke8 h3 h5");
    expect(t.deepest?.name).toMatch(/^Ruy Lopez: Berlin Defense/);
    expect(t.leftAt).not.toBeNull();
    // le Gambit dame refusé atteint par 1.Nf3 (transposition)
    expect(trace("Nf3 d5 d4 Nf6 c4 e6 Nc3 Be7").deepest?.name).toMatch(/Queen's Gambit Declined/);
  });
  it("sous-lignes possibles à chaque coup", () => {
    const t = trace("e4 e5 Nf3 Nc6 Bb5 Nf6");
    const alt3 = t.plies[4]!.alternatives.map((a) => a.san);
    expect(alt3).toEqual(expect.arrayContaining(["Bc4", "d4", "Nc3"])); // au lieu de 3.Bb5 : Italienne, Écossaise, Trois cavaliers
    const alt3b = t.plies[5]!.alternatives;
    expect(alt3b.find((a) => a.san === "a6")?.name).toMatch(/Ruy Lopez: Morphy Defense/);
  });
  it("noms en français pour la famille", () => {
    expect(frenchOpening("Ruy Lopez: Berlin Defense, Rio Gambit Accepted")).toBe("Partie espagnole : Berlin Defense, Rio Gambit Accepted");
    expect(frenchOpening("Queen's Gambit Declined")).toBe("Gambit dame refusé");
  });
});
