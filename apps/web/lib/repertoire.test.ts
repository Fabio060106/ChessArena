import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import type { RepertoireGame } from "@chessarena/shared";
import { buildTree, emptyDoc, exportPgn, fenKey, isDue, judge, positionsToAnalyse, review, syncCards, START, type RepertoireDoc } from "./repertoire";

const g = (pgn: string, color: "w" | "b", outcome: RepertoireGame["outcome"], i = 0): RepertoireGame => ({
  gameId: `g${i}-${pgn.length}`, endedAt: new Date(2026, 10, 1 + i).toISOString(), color, opponent: "papa", outcome, timeControl: "blitz_3_0", pgn,
});
const fenAfter = (...sans: string[]) => { const c = new Chess(); for (const s of sans) c.move(s); return c.fen(); };
const BLUNDER = "1. e4 Nf6 2. e5 Nd5 3. Bc4 Nb6 4. Bxf7+ Kxf7";
const games = [
  g(BLUNDER + " 5. Qf3+ Kg8", "w", "loss", 1),
  g(BLUNDER + " 5. d4 d6", "w", "loss", 2),
  g(BLUNDER, "w", "draw", 3),
  g("1. e4 e5 2. Nf3 Nc6 3. Bb5", "w", "win", 4),
  g("1. d4 d5 2. c4", "b", "win", 5),
];

/** évaluations fictives : la position avant 4.Bxf7+ est égale, après elle est perdante pour les Blancs */
function evaluated(): RepertoireDoc {
  const doc = emptyDoc();
  const before = fenAfter("e4", "Nf6", "e5", "Nd5", "Bc4", "Nb6");
  doc.evals[fenKey(before)] = { cp: 20, best: "c4b3", bestSan: "Bb3", depth: 14 };
  doc.evals[fenKey(fenAfter("e4", "Nf6", "e5", "Nd5", "Bc4", "Nb6", "Bxf7+"))] = { cp: -350, best: "e8f7", bestSan: "Kxf7", depth: 14 };
  return doc;
}

describe("répertoire", () => {
  it("construit l'arbre d'une couleur avec fréquences et score", () => {
    const t = buildTree(games, "w");
    expect(t.games).toBe(4);
    const root = t.nodes.get(fenKey(START))!;
    expect(root.moves).toEqual([expect.objectContaining({ san: "e4", count: 4, points: 1.5 })]);
    const afterE4 = t.nodes.get(fenKey(fenAfter("e4")))!;
    expect(afterE4.moves.map((m) => [m.san, m.count])).toEqual([["Nf6", 3], ["e5", 1]]);
    expect(buildTree(games, "b").games).toBe(1);
  });

  it("liste les positions à analyser, les plus jouées d'abord, sans refaire celles en cache", () => {
    const t = buildTree(games, "w");
    const p = positionsToAnalyse(t, emptyDoc());
    expect(p[0]).toBe(START);
    expect(p).toContain(fenAfter("e4", "Nf6", "e5", "Nd5", "Bc4", "Nb6"));
    const doc = emptyDoc(); doc.evals[fenKey(START)] = { cp: 30, best: "e2e4", bestSan: "e4", depth: 14 };
    expect(positionsToAnalyse(t, doc)).not.toContain(START);
  });

  it("repère l'erreur répétée et en fait un exercice, dû tout de suite", () => {
    const t = buildTree(games, "w");
    const doc = syncCards(t, evaluated());
    const key = fenKey(fenAfter("e4", "Nf6", "e5", "Nd5", "Bc4", "Nb6"));
    expect(judge(fenAfter("e4", "Nf6", "e5", "Nd5", "Bc4", "Nb6"), "c4f7", doc, "w")!.mark).toBe("??");
    expect(doc.cards[key]).toMatchObject({ playedSan: "Bxf7+", times: 3, mark: "??", bestSan: "Bb3", streak: 0 });
    expect(isDue(doc.cards[key]!)).toBe(true);
    expect(Object.keys(doc.cards)).toHaveLength(1);
  });

  it("exercice réussi : le coup trouvé entre dans le répertoire, révision repoussée (1 j, 3 j, 7 j…)", () => {
    const t = buildTree(games, "w");
    const key = fenKey(fenAfter("e4", "Nf6", "e5", "Nd5", "Bc4", "Nb6"));
    const now = new Date("2026-11-04T12:00:00Z");
    let doc = review(syncCards(t, evaluated(), now), key, true, { uci: "c4b3", san: "Bb3" }, now);
    expect(doc.choices[key]).toMatchObject({ uci: "c4b3", san: "Bb3" });
    expect(doc.cards[key]!.due).toBe("2026-11-05T12:00:00.000Z");
    doc = review(doc, key, true, { uci: "c4b3", san: "Bb3" }, now);
    expect(doc.cards[key]!.due).toBe("2026-11-07T12:00:00.000Z");
    doc = review(doc, key, false, null, now);
    expect(doc.cards[key]).toMatchObject({ streak: 0, failed: 1 });
    // re-synchronisation (nouvelle partie) : la progression est conservée
    expect(syncCards(t, doc).cards[key]!.solved).toBe(2);
  });

  it("export PGN : coup corrigé en ligne principale, ancienne erreur en sous-variante, importable", () => {
    const t = buildTree(games, "w");
    const key = fenKey(fenAfter("e4", "Nf6", "e5", "Nd5", "Bc4", "Nb6"));
    const doc = review(syncCards(t, evaluated()), key, true, { uci: "c4b3", san: "Bb3" });
    const pgn = exportPgn(t, doc, "fabio", new Date("2026-11-04"));
    expect(pgn).toContain('[Event "Répertoire ChessArena - Blancs"]');
    expect(pgn).toContain('[White "fabio"]');
    const flat = pgn.replace(/\s+/g, " ");
    expect(flat).toMatch(/4\. Bb3 \{coup de répertoire \(appris à l'entraînement\)\}/);
    expect(flat).toMatch(/\(4\. Bxf7\+ \$4 \{ton ancienne erreur - jouée 3 fois\}\)/);
    expect(flat).toMatch(/\(1\.\.\. e5/); // variante adverse 1…e5 (Espagnole)
    // le PGN se relit (chess.js suit la ligne principale)
    const c = new Chess();
    c.loadPgn(pgn);
    expect(c.history().slice(0, 7)).toEqual(["e4", "Nf6", "e5", "Nd5", "Bc4", "Nb6", "Bb3"]);
    expect(pgn.split("\n").every((l) => l.length <= 80)).toBe(true);
  });
});
