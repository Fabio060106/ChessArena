import { describe, expect, it } from "vitest";
import type { GameStateEvent } from "@chessarena/shared";
import { material } from "./material";
import { tryLocalMove } from "./moves";
import { nextHistory, START_FEN } from "./gameReducer";

const after = (...ucis: string[]) => ucis.reduce((f, u) => tryLocalMove(f, u.slice(0, 2), u.slice(2, 4))!.fen, START_FEN);

describe("comptage des pièces", () => {
  it("égalité au départ, +1 après un pion pris, pièces prises affichées du côté du preneur", () => {
    expect(material(START_FEN)).toEqual({ w: { captured: "", plus: 0 }, b: { captured: "", plus: 0 } });
    const m = material(after("e2e4", "d7d5", "e4d5"));
    expect(m.w).toEqual({ captured: "♟", plus: 1 });
    expect(m.b).toEqual({ captured: "", plus: 0 });
  });

  it("échange qualité : tour contre cavalier = +2 pour celui qui a la tour", () => {
    // Blancs : roi + tour ; Noirs : roi + cavalier
    const m = material("4k3/8/8/8/8/2n5/8/R3K3 w - - 0 1");
    expect(m.w.plus).toBe(2);
    expect(m.b.plus).toBe(0);
    expect(m.w.captured).toBe("♛♜♜♝♝♞♟♟♟♟♟♟♟♟");
  });

  it("promotion : jamais de compte négatif", () => {
    const m = material("QQ2k3/8/8/8/8/8/8/4K3 w - - 0 1");
    expect(m.w.plus).toBe(18);
    // les Blancs ont 2 dames (une promue) : aucune dame blanche ne figure parmi les prises noires
    expect(m.b.captured).not.toContain("♛");
  });
});

describe("liste des coups", () => {
  const st = (ply: number, fen: string, last: string | null): GameStateEvent =>
    ({ gameId: "g", fen, lastMoveUci: last, ply, whiteMs: 0, blackMs: 0, turn: "w", serverTs: 0 });
  it("notation reconstruite coup par coup ; trous marqués après une reconnexion", () => {
    let moves: Array<string | null> = [];
    let prev = st(0, START_FEN, null);
    for (const [i, u] of ["e2e4", "e7e5", "g1f3"].entries()) {
      const next = st(i + 1, after(...["e2e4", "e7e5", "g1f3"].slice(0, i + 1)), u);
      moves = nextHistory(moves, prev, next);
      prev = next;
    }
    expect(moves).toEqual(["e4", "e5", "Nf3"]);
    expect(nextHistory(moves, prev, st(5, START_FEN, "b8c6"))).toEqual(["e4", "e5", "Nf3", null, null]);
  });
});

describe("relecture d'une partie", () => {
  it("positions successives depuis le PGN, dates relatives, temps de réflexion", async () => {
    const { replayFromPgn, relativeDate, formatThink } = await import("./replay");
    const steps = replayFromPgn('[Event "x"]\n\n1. f3 e5 2. g4 Qh4# 0-1');
    expect(steps).toHaveLength(5);
    expect(steps[0]!.san).toBeNull();
    expect(steps.map((s) => s.san)).toEqual([null, "f3", "e5", "g4", "Qh4#"]);
    expect(steps[4]!.uci).toBe("d8h4");
    const now = Date.parse("2026-11-04T12:00:00Z");
    expect(relativeDate("2026-11-04T11:58:00Z", now)).toBe("il y a 2 min");
    expect(relativeDate("2026-11-03T10:00:00Z", now)).toBe("hier");
    expect(formatThink(2400)).toBe("2,4 s");
    expect(formatThink(42_000)).toBe("42 s");
  });
});
