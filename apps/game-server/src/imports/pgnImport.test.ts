import { describe, expect, it } from "vitest";
import { pgnMainline, pgnPlayerKey, pgnSpeed, splitPgnGames } from "@chessarena/shared";
import { parsePgnImport } from "./pgnImport.js";

const FILE = `﻿[Event "Open de Nice"]
[Site "Nice"]
[Date "2024.03.17"]
[Round "3"]
[White "Dupont, Jean"]
[Black "Martin, Paul"]
[Result "1-0"]
[WhiteElo "1850"]
[BlackElo "1790"]
[Annotator "GM X"]

1. e4 {Le meilleur coup selon l'auteur} e5 2. Nf3 (2. f4 exf4 3. Nf3 (3. Bc4)) Nc6 $1 3. Bb5!? a6 4. Ba4 Nf6
5. 0-0 Be7 1-0

[Event "Interclubs"]
[Date "2024.??.??"]
[White "Durand, Luc"]
[Black "Jean Dupont"]
[Result "0-1"]
[TimeControl "180+2"]

1.d4 d5 2.c4 e6 3.Nc3 Nf6 0-1

[Event "Partie sans le joueur"]
[White "A"]
[Black "B"]
[Result "1/2-1/2"]

1. e4 e5 2. Nf3 Nc6 1/2-1/2

[Event "Partie illisible"]
[White "Dupont, Jean"]
[Black "C"]
[Result "1-0"]

1. e4 e5 2. Ke3 1-0
`;

describe("fichiers PGN", () => {
  it("découpe les parties et lit les en-têtes", () => {
    const g = splitPgnGames(FILE);
    expect(g).toHaveLength(4);
    expect(g[0]!.tags.White).toBe("Dupont, Jean");
    expect(g[1]!.tags.Date).toBe("2024.??.??");
  });
  it("garde la ligne principale sans commentaires, variantes ni NAG", () => {
    expect(pgnMainline(splitPgnGames(FILE)[0]!.movetext)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7"]);
    expect(pgnMainline("1.d4 d5 2.c4 e6 0-1")).toEqual(["d4", "d5", "c4", "e6"]);
    expect(pgnMainline("1. e4 e5 2. Nf3 ; commentaire\nNc6 *")).toEqual(["e4", "e5", "Nf3", "Nc6"]);
  });
  it("reconnaît un joueur sous plusieurs écritures", () => {
    expect(pgnPlayerKey("Dupont, Jean")).toBe(pgnPlayerKey("Jean Dupont"));
    expect(pgnPlayerKey("Élodie Lefèvre")).toBe(pgnPlayerKey("Lefevre, elodie"));
  });
  it("devine la cadence", () => {
    expect(pgnSpeed("5400+30")).toBe("classical");
    expect(pgnSpeed("180+2")).toBe("blitz");
    expect(pgnSpeed("600")).toBe("rapid");
    expect(pgnSpeed(undefined)).toBe("classical");
  });
  it("importe les parties du joueur, sans annotations, et ignore les autres", () => {
    const { games, skipped } = parsePgnImport(FILE, ["Dupont, Jean"]);
    expect(games).toHaveLength(2);
    expect(skipped).toBe(2);
    const [a, b] = games;
    expect(a).toMatchObject({ source: "pgn", color: "w", outcome: "win", opponent: "Martin, Paul (1790)", speed: "classical", account: "Dupont, Jean" });
    expect(a!.playedAt.startsWith("2024-03-17")).toBe(true);
    expect(a!.pgn).not.toContain("auteur");
    expect(a!.pgn).not.toContain("Annotator");
    expect(a!.pgn).not.toContain("f4");
    expect(a!.pgn).toContain("1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 1-0");
    expect(b).toMatchObject({ color: "b", outcome: "win", speed: "blitz" });
    // identifiant stable : un second import ne double pas les parties
    expect(parsePgnImport(FILE, ["Jean Dupont"]).games.map((g) => g.extId)).toEqual(games.map((g) => g.extId));
  });
});
