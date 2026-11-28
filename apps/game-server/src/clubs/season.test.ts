import { describe, expect, it } from "vitest";
import type { SngSnapshot } from "@chessarena/shared";
import { clubSeason, monthOf } from "./season.js";

const snap = (id: string, finishedAt: string, ranks: Array<[string, number, string?]>, extra: Partial<SngSnapshot> = {}) => ({
  id, status: "finished", finishedAt, club: { slug: "fous", name: "Fous" }, teamBattle: null,
  players: ranks.map(([userId, finalRank, team]) => ({ userId, finalRank, team: team ?? null })), ...extra,
}) as unknown as SngSnapshot;

describe("classement du mois d'un club", () => {
  const now = Date.parse("2026-11-28T12:00:00Z");
  it("mois en cours", () => {
    expect(monthOf(now)).toEqual({ start: Date.parse("2026-11-01T00:00:00Z"), month: "2026-11" });
  });

  it("points de place cumulés ; participation récompensée ; mois précédent et autres clubs ignorés", () => {
    const s = clubSeason([
      snap("t1", "2026-11-07T21:00:00Z", [["ana", 1], ["bob", 2], ["cid", 3], ["dan", 4], ["eve", 5], ["fox", 6]]),
      snap("t2", "2026-11-14T21:00:00Z", [["bob", 1], ["ana", 2], ["fox", 3]]),
      snap("old", "2026-10-31T21:00:00Z", [["fox", 1], ["ana", 2]]),
      snap("other", "2026-11-20T21:00:00Z", [["fox", 1], ["ana", 2]], { club: { slug: "tours", name: "Tours" } }),
    ], "fous", now);
    expect(s).toMatchObject({ month: "2026-11", tournaments: 2 });
    expect(s.rows.map((r) => [r.userId, r.points, r.played, r.wins, r.podiums])).toEqual([
      ["ana", 17, 2, 1, 2], ["bob", 17, 2, 1, 2], ["fox", 7, 2, 0, 1], ["cid", 5, 1, 0, 1], ["dan", 4, 1, 0, 0], ["eve", 3, 1, 0, 0],
    ]);
  });

  it("bataille de clubs : seuls les joueurs du club comptent, classés entre eux", () => {
    const s = clubSeason([
      snap("b", "2026-11-21T21:00:00Z", [["x1", 1, "tours"], ["f1", 2, "fous"], ["x2", 3, "tours"], ["f2", 4, "fous"]],
        { club: { slug: "tours", name: "Tours" }, teamBattle: { leaders: 3, teams: [{ slug: "tours", name: "Tours", score: 0, players: 2, top: [] }, { slug: "fous", name: "Fous", score: 0, players: 2, top: [] }] } as never }),
    ], "fous", now);
    expect(s.rows.map((r) => [r.userId, r.points])).toEqual([["f1", 10], ["f2", 7]]);
  });
});

describe("champions du mois (tournois officiels)", () => {
  it("seuls les tournois officiels du mois comptent", async () => {
    const { officialSeason } = await import("./season.js");
    const { OFFICIAL_CREATOR } = await import("@chessarena/shared");
    const now = Date.parse("2026-11-28T12:00:00Z");
    const s = officialSeason([
      snap("o1", "2026-11-27T20:45:00Z", [["ana", 1], ["bob", 2], ["cid", 3]], { createdBy: OFFICIAL_CREATOR, club: null }),
      snap("p1", "2026-11-27T20:45:00Z", [["bob", 1], ["ana", 2]], { createdBy: "bob", club: null }),
      snap("o0", "2026-10-30T20:45:00Z", [["cid", 1], ["ana", 2]], { createdBy: OFFICIAL_CREATOR, club: null }),
    ], now);
    expect(s.tournaments).toBe(1);
    expect(s.rows.map((r) => [r.userId, r.points])).toEqual([["ana", 10], ["bob", 7], ["cid", 5]]);
  });

  it("stockage : tournois terminés d'un organisateur depuis une date", async () => {
    const { InMemoryTournamentStore } = await import("../tournaments/TournamentStore.js");
    const st = new InMemoryTournamentStore();
    for (const [id, by, at] of [["a", "@ChessAurum", "2026-11-20T20:00:00Z"], ["b", "@ChessAurum", "2026-10-20T20:00:00Z"], ["c", "bob", "2026-11-21T20:00:00Z"]] as const) {
      await st.save({ ...snap(id, at, [["x", 1]]), createdBy: by } as SngSnapshot);
    }
    expect((await st.finishedBy("@ChessAurum", "2026-11-01T00:00:00.000Z", 10)).map((x) => x.id)).toEqual(["a"]);
  });
});
