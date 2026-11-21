import { describe, expect, it } from "vitest";

describe("détail d'un match du tableau", () => {
  const g = (kind: "main" | "rematch" | "armageddon", result: "1-0" | "0-1" | "1/2-1/2", termination = "agreement") =>
    ({ gameId: kind, white: "grospd", black: "Stanchess17", kind, result, termination } as never);
  it("finale nulle partout : l'Armageddon explique la qualification", async () => {
    const { matchDetail } = await import("./tournament");
    const m = { round: 2, slot: 0, p1: "grospd", p2: "Stanchess17", winner: "Stanchess17", status: "done", games: [g("main", "1/2-1/2"), g("rematch", "1/2-1/2"), g("armageddon", "1/2-1/2")] } as never;
    expect(matchDetail(m)).toEqual({ score: "½-½ · revanche ½-½ · Armageddon ½-½", why: "nulle à l'Armageddon : les Noirs passent" });
  });
  it("premier coup non joué", async () => {
    const { matchDetail } = await import("./tournament");
    const m = { round: 1, slot: 0, p1: "grospd", p2: "Stanchess17", winner: "Stanchess17", status: "done", games: [g("main", "1/2-1/2", "aborted")] } as never;
    expect(matchDetail(m)).toEqual({ score: "1er coup non joué", why: "grospd n'a pas joué son premier coup" });
  });
});
