import { describe, expect, it } from "vitest";
import type { RelayGameView, RelayRoundView } from "@chessarena/shared";
import { lccGameView, normResult, parseLccMove, parseLccUrl, roundCandidates } from "./lcc.js";
import { InMemoryRelayStore, RelayService } from "./RelayService.js";

const ID = "e3537c1f-9200-40d7-9955-c244a536fa4c";
const gukesh = { fname: "Gukesh", lname: "D", title: "GM", fideid: 46616543 };
const sindarov = { fname: "Javokhir", lname: "Sindarov", title: "GM", fideid: 14205483 };

/** Faux LiveChessCloud : un dictionnaire url → JSON, modifiable pendant le test. */
function fakeLcc() {
  const data = new Map<string, unknown>();
  const calls: string[] = [];
  const base = `http://pool.test/get/${ID}`;
  return {
    data, calls,
    set: (path: string, v: unknown) => data.set(`${base}/${path}`, v),
    fetchJson: async (url: string) => { calls.push(url); if (url.includes("panne")) throw new Error("HTTP 502"); return data.has(url) ? structuredClone(data.get(url)) : null; },
  };
}

describe("LiveChessCloud : lecture des données", () => {
  it("liens acceptés", () => {
    expect(parseLccUrl(`https://view.livechesscloud.com/#${ID}/3`)).toEqual({ id: ID, round: 3 });
    expect(parseLccUrl(`http://view.livechesscloud.com#${ID}`)).toEqual({ id: ID, round: 0 });
    expect(parseLccUrl(ID.toUpperCase())).toEqual({ id: ID, round: 0 });
    expect(parseLccUrl("https://lichess.org/broadcast/x")).toBeNull();
  });
  it("coups au format DGT (« dxe4 63 », « fxe4 +31 », « Nc2 34+2 »)", () => {
    expect(parseLccMove("dxe4 63")).toEqual({ san: "dxe4", clock: 63 });
    expect(parseLccMove("fxe4 +31")).toEqual({ san: "fxe4", clock: null });
    expect(parseLccMove("Nc2 34+2")).toEqual({ san: "Nc2", clock: 34 });
    expect(parseLccMove("O-O")).toEqual({ san: "O-O", clock: null });
  });
  it("résultats", () => {
    expect(normResult("1-0")).toBe("1-0");
    expect(normResult("½-½")).toBe("1/2-1/2");
    expect(normResult("*")).toBeNull();
    expect(normResult("NOTPLAYED")).toBeNull();
  });
  it("partie : coups, position, pendules (l'horloge séparée l'emporte), coup illisible = arrêt", () => {
    const v = lccGameView(1, { live: true, white: sindarov, black: gukesh, result: "*" },
      { moves: ["e4 7190+10", "e5 7195+5", "Nf3 7100", "Nc6 7150", "Bb5 7000", "Xz9 1"], result: null, clock: { white: 6990, black: 7140, time: 1_700_000_000_000 } }, 5);
    expect(v.sans).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5"]);
    expect(v.ucis).toEqual(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"]);
    expect(v.turn).toBe("b");
    expect(v.clocks).toEqual({ w: 6990, b: 7140 });
    expect(v.clockAt).toBe(1_700_000_000_000);
    expect(v.live).toBe(true);
    expect(v.white).toEqual({ name: "Javokhir Sindarov", title: "GM", fideId: 14205483 });
    const done = lccGameView(2, { live: false, white: gukesh, black: sindarov, result: "1/2-1/2" }, null, 5);
    expect(done).toMatchObject({ result: "1/2-1/2", live: false, sans: [], clockAt: 5 });
  });
  it("ronde automatique : celle en cours, sinon les plus récentes d'abord", () => {
    expect(roundCandidates({ rounds: [{ count: 1, live: 0 }, { count: 1, live: 1 }, { count: 1, live: 0 }] })).toEqual([2]);
    expect(roundCandidates({ rounds: [{ count: 1, live: 0 }, { count: 1, live: 0 }, { count: 0, live: 0 }] })).toEqual([2, 1]);
  });
});

describe("RelayService", () => {
  const setup = () => {
    const lcc = fakeLcc();
    const rounds: RelayRoundView[] = [];
    const games: RelayGameView[] = [];
    const svc = new RelayService({
      store: new InMemoryRelayStore(), fetchJson: lcc.fetchJson, pool: "http://pool.test", autoStart: false,
      watchers: () => 1, onRound: (r) => rounds.push(r), onGame: (_id, _r, g) => games.push(g), now: () => 1000,
    });
    return { lcc, svc, rounds, games };
  };

  it("suit la ronde en cours, n'envoie que les parties qui changent, ne relit plus une partie finie", async () => {
    const { lcc, svc, rounds, games } = setup();
    lcc.set("tournament.json", { name: "FIDE World Championship 2026", rounds: [{ count: 1, live: 0 }, { count: 1, live: 1 }] });
    lcc.set("round-2/index.json", { date: "2026-11-25", pairings: [{ live: true, white: gukesh, black: sindarov, result: "*" }] });
    lcc.set("round-2/game-1.json", { moves: ["d4 7200", "Nf6 7200"], result: null, clock: { white: 7200, black: 7200, time: 1 } });
    const rec = await svc.add({ name: "Championnat du monde", lccId: ID, round: 0, createdBy: "Fabio060106" });
    await svc.poll(rec.id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ name: "Championnat du monde", tournamentName: "FIDE World Championship 2026", currentRound: 2, live: true, games: 1 });
    expect(rounds[0]!.gameList[0]!.sans).toEqual(["d4", "Nf6"]);

    await svc.poll(rec.id); // rien n'a bougé
    expect(games).toHaveLength(0);

    lcc.set("round-2/game-1.json", { moves: ["d4 7200", "Nf6 7200", "c4 7150"], result: null, clock: { white: 7150, black: 7200, time: 2 } });
    await svc.poll(rec.id);
    expect(games.map((g) => g.sans.length)).toEqual([3]);

    lcc.set("round-2/index.json", { pairings: [{ live: false, white: gukesh, black: sindarov, result: "1-0" }] });
    lcc.set("round-2/game-1.json", { moves: ["d4 7200", "Nf6 7200", "c4 7150"], result: "1-0" });
    await svc.poll(rec.id);
    expect(games.at(-1)).toMatchObject({ result: "1-0", live: false });
    lcc.calls.length = 0;
    await svc.poll(rec.id);
    expect(lcc.calls.some((u) => u.includes("game-1.json"))).toBe(false);
    expect(svc.list()[0]).toMatchObject({ id: rec.id, currentRound: 2, live: false, error: null });
  });

  it("passe à la nouvelle ronde quand elle commence (ronde automatique)", async () => {
    const { lcc, svc, rounds } = setup();
    lcc.set("tournament.json", { rounds: [{ count: 1, live: 0 }, { count: 1, live: 0 }] });
    lcc.set("round-1/index.json", { pairings: [{ white: gukesh, black: sindarov, result: "1/2-1/2" }] });
    lcc.set("round-2/index.json", { pairings: [{ white: sindarov, black: gukesh, result: "*" }] });
    const rec = await svc.add({ name: "CM", lccId: ID, round: 0, createdBy: "x" });
    await svc.poll(rec.id);
    expect(rounds.at(-1)!.currentRound).toBe(1); // la 2 n'a pas commencé
    lcc.set("tournament.json", { rounds: [{ count: 1, live: 0 }, { count: 1, live: 1 }] });
    lcc.set("round-2/index.json", { pairings: [{ live: true, white: sindarov, black: gukesh, result: "*" }] });
    lcc.set("round-2/game-1.json", { moves: ["e4 7200"] });
    await svc.poll(rec.id);
    expect(rounds.at(-1)).toMatchObject({ currentRound: 2, live: true });
    expect(rounds.at(-1)!.gameList[0]!.white.name).toBe("Javokhir Sindarov");
  });

  it("source en panne : message d'erreur, données gardées ; suppression", async () => {
    const { lcc, svc } = setup();
    lcc.set("tournament.json", { rounds: [{ count: 1, live: 1 }] });
    lcc.set("round-1/index.json", { pairings: [{ live: true, white: gukesh, black: sindarov }] });
    const rec = await svc.add({ name: "CM", lccId: ID, round: 1, createdBy: "x" });
    await svc.poll(rec.id);
    expect(svc.view(rec.id)!.gameList).toHaveLength(1);
    lcc.data.clear();
    const broken = new RelayService({
      store: new InMemoryRelayStore(), fetchJson: async () => { throw new Error("HTTP 502"); }, autoStart: false,
      watchers: () => 0, onRound: () => {}, onGame: () => {},
    });
    const r2 = await broken.add({ name: "panne", lccId: ID, round: 1, createdBy: "x" });
    await broken.poll(r2.id);
    expect(broken.view(r2.id)!.error).toMatch(/injoignable/);
    expect(await svc.remove(rec.id)).toBe(true);
    expect(svc.list()).toEqual([]);
  });
});
