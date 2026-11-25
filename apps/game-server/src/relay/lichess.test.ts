import { describe, expect, it } from "vitest";
import type { RelayGameView, RelayRoundView } from "@chessarena/shared";
import { decodeLichess, encodeLichess, lichessPgnGames, parseLichessUrl, pickLichessRound } from "./lichess.js";
import { InMemoryRelayStore, RelayService } from "./RelayService.js";

const PGN = `[Event "FIDE World Championship 2026"]
[Round "3"]
[White "Gukesh D"]
[Black "Sindarov, Javokhir"]
[WhiteTitle "GM"]
[BlackTitle "GM"]
[WhiteFideId "46616543"]
[Result "*"]

1. d4 { [%clk 1:59:55] } 1... Nf6 { [%clk 1:59:50] } 2. c4 { [%clk 1:58:10] } *


[Event "FIDE World Championship 2026"]
[Round "3"]
[White "Autre"]
[Black "Joueur"]
[Result "1/2-1/2"]

1. e4 e5 1/2-1/2
`;

describe("Lichess Broadcast : lecture", () => {
  it("liens de tournoi et de ronde", () => {
    expect(parseLichessUrl("https://lichess.org/broadcast/fide-world-championship-2026/AbCd1234")).toEqual({ kind: "tour", id: "AbCd1234" });
    expect(parseLichessUrl("https://lichess.org/broadcast/fide-world-championship-2026/game-3/XyZ98765")).toEqual({ kind: "round", id: "XyZ98765" });
    expect(parseLichessUrl("https://lichess.org/broadcast/fide-wc/game-3/XyZ98765/chapter12")).toEqual({ kind: "round", id: "XyZ98765" });
    expect(parseLichessUrl("https://exemple.com/broadcast/a/AbCd1234")).toBeNull();
    expect(parseLichessUrl("https://lichess.org/@/someone")).toBeNull();
    expect(decodeLichess(encodeLichess({ kind: "round", id: "XyZ98765" }))).toEqual({ kind: "round", id: "XyZ98765" });
  });
  it("PGN d'une ronde : joueurs, titres, coups, pendules [%clk], résultat", () => {
    const [g1, g2] = lichessPgnGames(PGN, 42);
    expect(g1).toMatchObject({
      index: 1, white: { name: "Gukesh D", title: "GM", fideId: 46616543 }, black: { name: "Sindarov, Javokhir", title: "GM", fideId: null },
      result: null, live: true, sans: ["d4", "Nf6", "c4"], ucis: ["d2d4", "g8f6", "c2c4"], turn: "b", clocks: { w: 7090, b: 7190 }, clockAt: 42,
    });
    expect(g2).toMatchObject({ index: 2, result: "1/2-1/2", live: false, sans: ["e4", "e5"], clocks: { w: null, b: null } });
  });
  it("ronde suivie : en cours, sinon la dernière finie", () => {
    expect(pickLichessRound({ rounds: [{ id: "a", name: "Game 1", finished: true }, { id: "b", name: "Game 2", ongoing: true }, { id: "c", name: "Game 3" }] }))
      .toEqual({ id: "b", name: "Game 2", number: 2 });
    expect(pickLichessRound({ rounds: [{ id: "a", finished: true }, { id: "b", finished: true }, { id: "c" }] })).toMatchObject({ id: "b", number: 2 });
    expect(pickLichessRound({ rounds: [] })).toBeNull();
  });
});

describe("RelayService avec Lichess", () => {
  it("suit le tournoi, passe à la ronde suivante, ralentit en cas de « trop de requêtes »", async () => {
    const json = new Map<string, unknown>();
    const text = new Map<string, string>();
    let tooMany = false;
    const rounds: RelayRoundView[] = []; const games: RelayGameView[] = [];
    const svc = new RelayService({
      store: new InMemoryRelayStore(), autoStart: false, lichess: "http://li.test", now: () => 1000,
      fetchJson: async (u) => json.get(u) ?? null,
      fetchText: async (u) => { if (tooMany) throw new Error("HTTP 429"); return text.get(u) ?? null; },
      watchers: () => 1, onRound: (r) => rounds.push(r), onGame: (_i, _r, g) => games.push(g),
    });
    json.set("http://li.test/api/broadcast/TOUR0001", { tour: { name: "FIDE World Championship 2026" }, rounds: [{ id: "RND00001", name: "Game 1", finished: true }, { id: "RND00002", name: "Game 2", ongoing: true }] });
    text.set("http://li.test/api/broadcast/round/RND00002.pgn", PGN);
    const rec = await svc.add({ name: "Championnat du monde", source: "lichess", lccId: "tour:TOUR0001", round: 0, createdBy: "x" });
    await svc.poll(rec.id);
    expect(rounds.at(-1)).toMatchObject({ currentRound: 2, roundName: "Game 2", tournamentName: "FIDE World Championship 2026", live: true, games: 2 });
    text.set("http://li.test/api/broadcast/round/RND00002.pgn", PGN.replace("2. c4 { [%clk 1:58:10] } *", "2. c4 { [%clk 1:58:10] } 2... e6 { [%clk 1:57:00] } *"));
    await svc.poll(rec.id);
    expect(games.map((g) => g.sans.join(" "))).toEqual(["d4 Nf6 c4 e6"]);
    json.set("http://li.test/api/broadcast/TOUR0001", { rounds: [{ id: "RND00001", finished: true }, { id: "RND00002", name: "Game 2", finished: true }, { id: "RND00003", name: "Game 3", ongoing: true }] });
    text.set("http://li.test/api/broadcast/round/RND00003.pgn", PGN);
    await svc.poll(rec.id);
    expect(rounds.at(-1)).toMatchObject({ currentRound: 3, roundName: "Game 3" });
    tooMany = true;
    await svc.poll(rec.id);
    expect(svc.list()[0]!.error).toMatch(/injoignable/);
  });

  it("lien d'une seule partie : retrouve le match et suit les parties suivantes", async () => {
    const json = new Map<string, unknown>(); const text = new Map<string, string>();
    const rounds: RelayRoundView[] = [];
    const svc = new RelayService({
      store: new InMemoryRelayStore(), autoStart: false, lichess: "http://li.test",
      fetchJson: async (u) => json.get(u) ?? null, fetchText: async (u) => text.get(u) ?? null,
      watchers: () => 1, onRound: (r) => rounds.push(r), onGame: () => {},
    });
    json.set("http://li.test/api/broadcast/-/-/L3j03TZq", { round: { id: "L3j03TZq", name: "Game 2" }, tour: { id: "WchTour1", name: "FIDE World Chess Championship 2026" } });
    json.set("http://li.test/api/broadcast/WchTour1", { rounds: [{ id: "xLgOJ6cb", name: "Game 1", finished: true }, { id: "L3j03TZq", name: "Game 2", finished: true }, { id: "G3game03", name: "Game 3", ongoing: true }] });
    text.set("http://li.test/api/broadcast/round/G3game03.pgn", PGN);
    const rec = await svc.add({ name: "CM", source: "lichess", lccId: "round:L3j03TZq", round: 0, createdBy: "x" });
    await svc.poll(rec.id);
    expect(rounds.at(-1)).toMatchObject({ roundName: "Game 3", currentRound: 3, tournamentName: "FIDE World Chess Championship 2026" });
  });

  it("rondes déjà jouées : liste, lecture à la demande (gardée), partie retrouvée", async () => {
    const json = new Map<string, unknown>(); const text = new Map<string, string>();
    let reads = 0;
    const svc = new RelayService({
      store: new InMemoryRelayStore(), autoStart: false, lichess: "http://li.test",
      fetchJson: async (u) => json.get(u) ?? null, fetchText: async (u) => { if (u.includes("GAME0001")) reads++; return text.get(u) ?? null; },
      watchers: () => 1, onRound: () => {}, onGame: () => {},
    });
    json.set("http://li.test/api/broadcast/TOUR0001", { rounds: [{ id: "GAME0001", name: "Game 1", finished: true }, { id: "GAME0002", name: "Game 2", ongoing: true }, { id: "GAME0003", name: "Game 3" }] });
    text.set("http://li.test/api/broadcast/round/GAME0002.pgn", PGN);
    text.set("http://li.test/api/broadcast/round/GAME0001.pgn", `[White "Sindarov"]\n[Black "Gukesh"]\n[Result "1/2-1/2"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 1/2-1/2\n`);
    const rec = await svc.add({ name: "CM", source: "lichess", lccId: "tour:TOUR0001", round: 0, createdBy: "x" });
    await svc.poll(rec.id);
    expect(svc.list()[0]!.rounds).toEqual([
      { number: 1, name: "Game 1", state: "finished" }, { number: 2, name: "Game 2", state: "ongoing" }, { number: 3, name: "Game 3", state: "upcoming" },
    ]);
    const r1 = await svc.roundView(rec.id, 1);
    expect(r1).toMatchObject({ currentRound: 1, roundName: "Game 1", live: false });
    expect(r1!.gameList[0]!.sans).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5", "Nf6"]);
    await svc.roundView(rec.id, 1);
    expect(reads).toBe(1); // partie finie : pas relue
    expect(svc.findGame(rec.id, 1, 1)?.result).toBe("1/2-1/2");
    expect(svc.findGame(rec.id, 2, 1)?.sans).toEqual(["d4", "Nf6", "c4"]);
    expect(await svc.roundView(rec.id, 9)).toBeNull();
  });
});
