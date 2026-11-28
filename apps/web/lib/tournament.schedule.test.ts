import { describe, expect, it } from "vitest";
import { defaultStart, startsIn } from "./tournament";

describe("tournois programmés : textes", () => {
  it("compte à rebours lisible", () => {
    const now = Date.parse("2026-11-28T10:00:00Z");
    expect(startsIn("2026-11-28T10:00:30Z", now)).toBe("dans 30 s");
    expect(startsIn("2026-11-28T10:45:00Z", now)).toBe("dans 45 min");
    expect(startsIn("2026-11-28T12:05:00Z", now)).toBe("dans 2 h 05");
    expect(startsIn("2026-11-28T13:00:00Z", now)).toBe("dans 3 h");
    expect(startsIn("2026-12-01T10:00:00Z", now)).toBe("dans 3 jours");
    expect(startsIn("2026-11-28T09:00:00Z", now)).toBe("imminent");
  });
  it("par défaut : ce soir 20:00, ou demain s'il est trop tard", () => {
    expect(defaultStart(new Date(2026, 10, 28, 15, 0))).toBe("2026-11-28T20:00");
    expect(defaultStart(new Date(2026, 10, 28, 19, 45))).toBe("2026-11-29T20:00");
    expect(defaultStart(new Date(2026, 11, 31, 22, 0))).toBe("2027-01-01T20:00");
  });
});

import { swissCrosstable } from "./tournament";
import type { SngSnapshot } from "@chessarena/shared";
describe("grille américaine", () => {
  it("adversaire par son rang, couleur, résultat ; exempt", () => {
    const p = (userId: string, points: number, seed: number) => ({ userId, rating: 1500, status: "eliminated", seed, eliminatedRound: null, finalRank: null, payoutCents: 0, points, buchholz: 0, sonnebornBerger: 0 });
    const s = {
      system: "swiss", status: "running", players: [p("a", 2, 1), p("b", 1, 2), p("c", 0.5, 3)],
      rounds: [
        [{ round: 1, slot: 0, p1: "a", p2: "b", winner: "a", status: "done", games: [], result: "1-0" }, { round: 1, slot: 1, p1: "c", p2: null, winner: "c", status: "done", games: [], result: "bye" }],
        [{ round: 2, slot: 0, p1: "c", p2: "a", winner: null, status: "done", games: [], result: "1/2-1/2" }, { round: 2, slot: 1, p1: "b", p2: null, winner: "b", status: "done", games: [], result: "bye" }],
      ],
    } as unknown as SngSnapshot;
    const g = swissCrosstable(s);
    expect(g.map((r) => r.row.userId)).toEqual(["a", "b", "c"]);
    expect(g[0]!.cells.map((c) => c.text)).toEqual(["+2B", "½3N"]);
    expect(g[1]!.cells.map((c) => c.text)).toEqual(["−1N", "+ exempt"]);
    expect(g[2]!.cells.map((c) => c.text)).toEqual(["+ exempt", "½1B"]);
  });
});
