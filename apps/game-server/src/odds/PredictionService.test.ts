import { describe, expect, it } from "vitest";
import type { RelayGameView } from "@chessarena/shared";
import { acct, InMemoryLedger } from "../settlement/ledger.js";
import { InMemoryBetStore, type Bet } from "./BetStore.js";
import { BetError, BETS_POOL, PredictionService, type MarketView } from "./PredictionService.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const game = (ucis: string[], fen: string, result: string | null = null): RelayGameView => ({
  index: 1, white: { name: "Gukesh", title: "GM", fideId: null }, black: { name: "Sindarov", title: "GM", fideId: null },
  result, live: !result, sans: ucis, ucis, fen, clocks: { w: null, b: null }, clockAt: 0, turn: fen.split(" ")[1] === "b" ? "b" : "w",
});

function setup(wdl = { w: 300, d: 600, l: 100 }) {
  const ledger = new InMemoryLedger();
  const store = new InMemoryBetStore();
  const odds: MarketView[] = [];
  const settled: Bet[] = [];
  let release: () => void = () => {};
  let hold = false;
  const svc = new PredictionService({
    ledger, store,
    evaluate: async () => { if (hold) await new Promise<void>((r) => (release = r)); return { wdl, cp: null, depth: 16 }; }, // cp null : le WDL donné sert directement
    emitOdds: (v) => odds.push(v), notify: (_u, b) => settled.push(b),
  });
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  return { svc, ledger, store, odds, settled, flush, holdEval: (v: boolean) => { hold = v; }, release: () => release() };
}
const bal = (l: InMemoryLedger, u: string) => l.balance(acct.user(u, "PLAY"), "PLAY");

describe("pronostics en jetons sur les parties retransmises", () => {
  it("cotes recalculées après chaque coup ; mise à la cote vue ; gain payé au résultat", async () => {
    const t = setup();
    await t.ledger.faucet("ana", 10_000, "w");
    await t.svc.onGame("wc", 7, game([], START));
    await t.flush();
    const v = t.odds.at(-1)!;
    expect(v.odds).toEqual({ white: 3.14, draw: 1.57, black: 9.43 });
    const { bet, balanceCents } = await t.svc.place("ana", { relayId: "wc", round: 7, index: 1, pick: "white", stakeCents: 1_000, version: v.version });
    expect(bet).toMatchObject({ odds: 3.14, ply: 0, label: "Gukesh – Sindarov, ronde 7", status: "open" });
    expect(balanceCents).toBe(9_000);
    expect(await t.ledger.balance(BETS_POOL, "PLAY")).toBe(1_000);
    await t.svc.onGame("wc", 7, game(["e2e4"], AFTER_E4, "1-0"));
    expect(await bal(t.ledger, "ana")).toBe(9_000 + 3_140);
    expect(t.settled.map((b) => [b.status, b.payoutCents])).toEqual([["won", 3_140]]);
    expect(await t.ledger.balance(BETS_POOL, "PLAY")).toBe(0);
    // résultat reçu deux fois : rien de plus
    await t.svc.onGame("wc", 7, game(["e2e4"], AFTER_E4, "1-0"));
    expect(await bal(t.ledger, "ana")).toBe(12_140);
  });

  it("après un coup, plus de mise tant que la nouvelle cote n'est pas calculée ; ancienne version refusée", async () => {
    const t = setup();
    await t.ledger.faucet("bob", 10_000, "w");
    await t.svc.onGame("wc", 7, game([], START));
    await t.flush();
    const old = t.odds.at(-1)!.version;
    t.holdEval(true);
    await t.svc.onGame("wc", 7, game(["e2e4"], AFTER_E4));
    const p = { relayId: "wc", round: 7, index: 1, pick: "draw" as const, stakeCents: 500 };
    await expect(t.svc.place("bob", { ...p, version: t.odds.at(-1)!.version })).rejects.toMatchObject({ code: "ODDS_PENDING" });
    t.release(); await t.flush();
    await expect(t.svc.place("bob", { ...p, version: old })).rejects.toMatchObject({ code: "ODDS_CHANGED" });
    await expect(t.svc.place("bob", { ...p, version: t.odds.at(-1)!.version })).resolves.toBeTruthy();
  });

  it("limites : mise de 1 à 25 jetons, 50 jetons engagés au plus par partie ; solde insuffisant ; perdu → rien", async () => {
    const t = setup();
    await t.ledger.faucet("cid", 6_000, "w");
    await t.svc.onGame("wc", 7, game([], START));
    await t.flush();
    const v = () => t.odds.at(-1)!.version;
    const p = (stakeCents: number) => ({ relayId: "wc", round: 7, index: 1, pick: "black" as const, stakeCents, version: v() });
    for (const s of [50, 2_600, 150]) await expect(t.svc.place("cid", p(s))).rejects.toMatchObject({ code: "STAKE_LIMIT" });
    await t.svc.place("cid", p(2_500)); await t.svc.place("cid", p(2_500));
    await expect(t.svc.place("cid", p(100))).rejects.toMatchObject({ code: "EXPOSURE_LIMIT" });
    await t.svc.onGame("wc", 8, game([], START));
    await t.flush();
    await expect(t.svc.place("cid", { ...p(2_500), round: 8, version: t.odds.at(-1)!.version })).rejects.toBeInstanceOf(BetError); // reste 10 jetons
    await t.svc.onGame("wc", 7, game([], START, "1/2-1/2"));
    expect(t.settled.map((b) => b.status)).toEqual(["lost", "lost"]);
    expect(await bal(t.ledger, "cid")).toBe(1_000);
    await expect(t.svc.place("cid", p(100))).rejects.toMatchObject({ code: "MARKET_CLOSED" });
  });

  it("issue quasi certaine : marché suspendu ; sans moteur : pas de cote, pas de pari", async () => {
    const t = setup({ w: 985, d: 15, l: 0 });
    await t.ledger.faucet("dan", 5_000, "w");
    await t.svc.onGame("wc", 7, game([], START));
    await t.flush();
    expect(t.odds.at(-1)!.suspended).toBe(true);
    await expect(t.svc.place("dan", { relayId: "wc", round: 7, index: 1, pick: "white", stakeCents: 100, version: t.odds.at(-1)!.version })).rejects.toMatchObject({ code: "SUSPENDED" });
    const none = new PredictionService({ ledger: t.ledger, store: new InMemoryBetStore(), evaluate: null, emitOdds: () => {}, notify: () => {} });
    await none.onGame("wc", 7, game([], START));
    await expect(none.place("dan", { relayId: "wc", round: 7, index: 1, pick: "white", stakeCents: 100, version: 1 })).rejects.toMatchObject({ code: "ODDS_PENDING" });
  });
});
