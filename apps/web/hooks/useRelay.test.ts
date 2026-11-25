import { describe, expect, it } from "vitest";
import type { RelayGameView, RelayRoundView } from "@chessarena/shared";
import { formatClock, mergeRelayGame, relayClock } from "./useRelay";

const g = (o: Partial<RelayGameView> = {}): RelayGameView => ({
  index: 1, white: { name: "A", title: null, fideId: null }, black: { name: "B", title: null, fideId: null },
  result: null, live: true, sans: ["e4"], ucis: ["e2e4"], fen: "", clocks: { w: 7190, b: 7200 }, clockAt: 0, turn: "b", ...o,
});

describe("retransmission côté navigateur", () => {
  it("pendules : seule celle du joueur au trait tourne, jamais sous zéro", () => {
    expect(relayClock(g(), "b", 10_000, 0)).toBe(7190);
    expect(relayClock(g(), "w", 10_000, 0)).toBe(7190);
    expect(relayClock(g({ result: "1-0", live: false }), "b", 10_000, 0)).toBe(7200);
    expect(relayClock(g({ clocks: { w: 5, b: 3 } }), "b", 60_000, 0)).toBe(0);
    expect(formatClock(7190)).toBe("1:59:50");
    expect(formatClock(59.6)).toBe("0:59");
    expect(formatClock(null)).toBe("—");
  });
  it("une partie mise à jour remplace l'ancienne, seulement pour la ronde affichée", () => {
    const r: RelayRoundView = { id: "x", name: "CM", round: 0, currentRound: 3, games: 1, live: true, updatedAt: 0, error: null, tournamentName: null, gameList: [g()] };
    const next = mergeRelayGame(r, 3, g({ sans: ["e4", "e5"], turn: "w", result: "1/2-1/2", live: false }));
    expect(next.gameList[0]!.sans).toEqual(["e4", "e5"]);
    expect(next.live).toBe(false);
    expect(mergeRelayGame(r, 2, g({ sans: [] }))).toBe(r);
    expect(mergeRelayGame(r, 3, g({ index: 2 })).gameList.map((x) => x.index)).toEqual([1, 2]);
  });
});
