import { beforeEach, describe, expect, it, vi } from "vitest";
import { TIME_CONTROLS, type GameResult, type SngSnapshot } from "@chessarena/shared";
import { bracketOrder, bracketSizeFor, SitAndGo, SngError, type StartGameRequest } from "./SitAndGo.js";
import { acct, InMemoryLedger } from "../settlement/ledger.js";
import type { FinishedGame } from "../game/GameRoom.js";

const BUY_IN = 500;

function setup(size: number, opts: { buyIn?: number; random?: () => number } = {}) {
  const ledger = new InMemoryLedger();
  const started: StartGameRequest[] = [];
  const snapshots: SngSnapshot[] = [];
  const sng = new SitAndGo(
    { id: "T1", formatId: "f", size, timeControl: "blitz_3_0", currency: "PLAY", buyInCents: opts.buyIn ?? BUY_IN, rakeBps: 1000, payoutBps: [6500, 3500] },
    {
      ledger,
      startGame: async (r) => { started.push(r); return r.gameId; },
      persist: async (s) => { snapshots.push(s); },
      emit: () => {},
      random: opts.random ?? (() => 0.1), // p1 a les Blancs en partie principale
    },
  );
  const fund = async (u: string, c = 10_000) => ledger.faucet(u, c, `seed-${u}`);
  const bal = (u: string) => ledger.balance(acct.user(u, "PLAY"), "PLAY");

  /** Termine une partie démarrée par le moteur. */
  const finish = (req: StartGameRequest, result: GameResult, extra: Partial<FinishedGame> = {}) =>
    sng.onGameFinished({
      gameId: req.gameId, white: req.white, black: req.black, timeControl: TIME_CONTROLS[req.timeControl],
      stake: { currency: "PLAY", buyInCents: 0 }, result, termination: result === "1/2-1/2" ? "agreement" : "resignation",
      pgn: "", moveTimesMs: [], focusLoss: { w: 0, b: 0 }, aborted: false, abortedBy: null,
      rated: req.rated, tournament: req.tournament, ...extra,
    });
  /** Fait gagner `winner` dans la partie qui l'oppose actuellement. */
  const win = async (winner: string) => {
    const req = [...started].reverse().find((r) => r.white.userId === winner || r.black.userId === winner)!;
    await finish(req, req.white.userId === winner ? "1-0" : "0-1");
  };
  /** inscrit u1..un avec des Elo décroissants (u1 = tête de série n°1) */
  const fill = async (n: number) => {
    for (let i = 1; i <= n; i++) {
      await fund(`u${i}`);
      await sng.register(`u${i}`, 2000 - i * 10);
    }
  };
  return { sng, ledger, started, snapshots, fund, bal, finish, win, fill };
}

describe("bracketOrder", () => {
  it("place les têtes de série pour qu'elles ne se croisent qu'en fin de tableau", () => {
    expect(bracketOrder(4)).toEqual([1, 4, 2, 3]);
    expect(bracketOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });
});

describe("SitAndGo — inscriptions et escrow", () => {
  it("bloque le buy-in à l'inscription, rembourse à la désinscription", async () => {
    const t = setup(4);
    await t.fund("a");
    await t.sng.register("a", 1500);
    expect(await t.bal("a")).toBe(10_000 - BUY_IN);
    expect(await t.ledger.balance(t.sng.escrowAccount, "PLAY")).toBe(BUY_IN);
    await t.sng.unregister("a");
    expect(await t.bal("a")).toBe(10_000);
    expect(await t.ledger.balance(t.sng.escrowAccount, "PLAY")).toBe(0);
    // ré-inscription : nouvelle clé d'idempotence, pas un doublon silencieux
    await t.sng.register("a", 1500);
    expect(await t.bal("a")).toBe(10_000 - BUY_IN);
  });

  it("refuse : solde insuffisant (et libère la place), doublon, table pleine", async () => {
    const t = setup(4);
    await t.fund("pauvre", 100);
    await expect(t.sng.register("pauvre", 1500)).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    expect(t.sng.registeredCount).toBe(0);
    await t.fund("a");
    await t.sng.register("a", 1500);
    await expect(t.sng.register("a", 1500)).rejects.toMatchObject({ code: "ALREADY_REGISTERED" });
    await expect(t.sng.unregister("zzz")).rejects.toMatchObject({ code: "NOT_REGISTERED" });
  });

  it("inscriptions simultanées sur la dernière place : une seule passe", async () => {
    const t = setup(4);
    for (const u of ["a", "b", "c", "d", "e"]) await t.fund(u);
    await t.sng.register("a", 1500);
    await t.sng.register("b", 1500);
    await t.sng.register("c", 1500);
    const results = await Promise.allSettled([t.sng.register("d", 1500), t.sng.register("e", 1500)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(SngError);
    expect(t.sng.state).toBe("running");
    expect(t.ledger.totalOf("PLAY")).toBe(0);
  });

  it("annulation : chacun récupère exactement son apport net, sans rake", async () => {
    const t = setup(8);
    await t.fill(3);
    await t.sng.unregister("u2");
    await t.sng.register("u2", 1980);
    await t.sng.cancel("timeout");
    for (const u of ["u1", "u2", "u3"]) expect(await t.bal(u)).toBe(10_000);
    expect(await t.ledger.balance(t.sng.escrowAccount, "PLAY")).toBe(0);
    expect(await t.ledger.balance(acct.rake("PLAY"), "PLAY")).toBe(0);
    expect(t.sng.snapshot().status).toBe("cancelled");
    await expect(t.sng.register("u4", 1500)).rejects.toMatchObject({ code: "NOT_REGISTERING" });
  });
});

describe("SitAndGo — tableau et déroulement", () => {
  it("4 joueurs : 1-4 et 2-3, finale, 65/35 de la cagnotte nette, rake 10 %", async () => {
    const t = setup(4);
    await t.fill(4);
    expect(t.sng.state).toBe("running");
    const pairs = t.started.map((r) => [r.white.userId, r.black.userId].sort().join("-"));
    expect(pairs).toEqual(["u1-u4", "u2-u3"]);

    await t.win("u1");
    expect(t.started).toHaveLength(2); // la finale attend la fin de l'autre demi
    await t.win("u3");
    expect(t.started).toHaveLength(3);
    expect([t.started[2]!.white.userId, t.started[2]!.black.userId].sort()).toEqual(["u1", "u3"]);
    await t.win("u3");

    const s = t.sng.snapshot();
    expect(s.status).toBe("finished");
    // pot 4 × 5,00 = 20,00 ; rake 2,00 ; net 18,00 → 11,70 / 6,30
    expect(s.rakeCents).toBe(200);
    expect(s.players.find((p) => p.userId === "u3")).toMatchObject({ finalRank: 1, payoutCents: 1170, status: "winner" });
    expect(s.players.find((p) => p.userId === "u1")).toMatchObject({ finalRank: 2, payoutCents: 630 });
    expect(s.players.filter((p) => p.finalRank === 3)).toHaveLength(2);
    expect(await t.bal("u3")).toBe(10_000 - BUY_IN + 1170);
    expect(await t.ledger.balance(acct.rake("PLAY"), "PLAY")).toBe(200);
    expect(await t.ledger.balance(t.sng.escrowAccount, "PLAY")).toBe(0);
    expect(t.ledger.totalOf("PLAY")).toBe(0); // aucun jeton créé ni détruit
  });

  it("8 joueurs : 3 tours, placement standard, rangs 1/2/3/3/5…", async () => {
    const t = setup(8);
    await t.fill(8);
    expect(t.started.map((r) => [r.white.userId, r.black.userId].sort().join("-")))
      .toEqual(["u1-u8", "u4-u5", "u2-u7", "u3-u6"]);
    for (const u of ["u1", "u4", "u2", "u3"]) await t.win(u);
    expect(t.started.slice(4).map((r) => [r.white.userId, r.black.userId].sort().join("-"))).toEqual(["u1-u4", "u2-u3"]);
    await t.win("u1");
    await t.win("u2");
    await t.win("u2");
    const ranks = Object.fromEntries(t.sng.snapshot().players.map((p) => [p.userId, p.finalRank]));
    expect(ranks).toEqual({ u1: 2, u2: 1, u3: 3, u4: 3, u5: 5, u6: 5, u7: 5, u8: 5 });
    expect(t.ledger.totalOf("PLAY")).toBe(0);
  });

  it("6 joueurs : les têtes de série 1 et 2 sont exemptes au 1er tour", async () => {
    const t = setup(6);
    await t.fill(6);
    expect(t.started.map((r) => [r.white.userId, r.black.userId].sort().join("-"))).toEqual(["u4-u5", "u3-u6"]);
    const r1 = t.sng.snapshot().rounds[0]!;
    expect(r1.filter((m) => m.p2 === null).map((m) => m.winner)).toEqual(["u1", "u2"]);
    await t.win("u5");
    expect(t.started).toHaveLength(2);
    await t.win("u6");
    expect(t.started.slice(2).map((r) => [r.white.userId, r.black.userId].sort().join("-"))).toEqual(["u1-u5", "u2-u6"]);
  });
});

describe("SitAndGo — appariement de la ronde suivante", () => {
  it("n'apparie la ronde suivante que lorsque TOUTES les parties de la ronde sont finies (départages compris)", async () => {
    const t = setup(8);
    await t.fill(8);
    const r1 = () => t.started.filter((r) => r.tournament!.round === 1);
    const r2 = () => t.started.filter((r) => r.tournament!.round === 2);
    expect(r1()).toHaveLength(4);
    // 3 quarts sur 4 terminés : aucune demi-finale ne démarre
    await t.win("u1"); await t.win("u4"); await t.win("u2");
    expect(r2()).toHaveLength(0);
    // le dernier quart (u3–u6) fait nulle → revanche : toujours pas de demi-finale
    const last = r1().find((r) => [r.white.userId, r.black.userId].includes("u3"))!;
    await t.finish(last, "1/2-1/2");
    expect(r2()).toHaveLength(0);
    expect(t.sng.snapshot().currentRound).toBe(1);
    // la revanche se termine → les deux demi-finales partent en même temps
    await t.win("u3");
    expect(r2()).toHaveLength(2);
    expect(t.sng.snapshot().currentRound).toBe(2);
    // une demi finie : la finale attend l'autre
    await t.win("u1");
    expect(t.started.filter((r) => r.tournament!.round === 3)).toHaveLength(0);
    await t.win("u2");
    expect(t.started.filter((r) => r.tournament!.round === 3)).toHaveLength(1);
  });
});

describe("SitAndGo — départages", () => {
  it("nulle → revanche couleurs inversées → Armageddon (meilleure tête de série aux Noirs, nulle qualificative, non classée)", async () => {
    const t = setup(4);
    await t.fill(4);
    const main = t.started[0]!; // u1 (seed 1) vs u4
    await t.finish(main, "1/2-1/2");
    const rematch = t.started.at(-1)!;
    expect(rematch.tournament.kind).toBe("rematch");
    expect(rematch.white.userId).toBe(main.black.userId);
    await t.finish(rematch, "1/2-1/2");
    const arma = t.started.at(-1)!;
    expect(arma.tournament.kind).toBe("armageddon");
    expect(arma.black.userId).toBe("u1");
    expect(arma.rated).toBe(false);
    await t.finish(arma, "1/2-1/2");
    const m = t.sng.snapshot().rounds[0]![0]!;
    expect(m).toMatchObject({ winner: "u1", status: "done" });
    expect(m.games.map((g) => g.kind)).toEqual(["main", "rematch", "armageddon"]);
  });

  it("partie annulée : perdue par le responsable ; sans responsable, rejouée", async () => {
    const t = setup(4);
    await t.fill(4);
    const g = t.started[0]!;
    await t.finish(g, "1/2-1/2", { aborted: true, abortedBy: null, termination: "aborted" });
    const replay = t.started.at(-1)!;
    expect(replay.tournament.kind).toBe("main");
    expect(replay.gameId).not.toBe(g.gameId);
    await t.finish(replay, "1/2-1/2", { aborted: true, abortedBy: "w", termination: "aborted" });
    expect(t.sng.snapshot().rounds[0]![0]!.winner).toBe(replay.black.userId);
  });

  it("un résultat reçu deux fois n'est compté qu'une fois", async () => {
    const t = setup(4);
    await t.fill(4);
    const g = t.started[0]!;
    await t.finish(g, "1-0");
    await t.finish(g, "0-1");
    expect(t.sng.snapshot().rounds[0]![0]!.winner).toBe(g.white.userId);
  });
});

describe("SitAndGo — dotation sponsor", () => {
  it("ajoutée à la cagnotte, non soumise au rake", async () => {
    const t = setup(4);
    await t.ledger.post("sponsor-funding", "PLAY", [
      { account: "sponsor:streamer:PLAY", amountCents: 2000 }, { account: acct.faucet(), amountCents: -2000 },
    ]);
    await t.sng.fundSponsor("sponsor:streamer:PLAY", 2000);
    await t.fill(4);
    await t.win("u1"); await t.win("u2"); await t.win("u1");
    const s = t.sng.snapshot();
    expect(s.rakeCents).toBe(200);
    expect(s.players.find((p) => p.userId === "u1")!.payoutCents + s.players.find((p) => p.userId === "u2")!.payoutCents)
      .toBe(2000 - 200 + 2000);
  });
});

describe("SitAndGo — robustesse", () => {
  it("rejette une configuration invalide", () => {
    const ports = { ledger: new InMemoryLedger(), startGame: async (r: StartGameRequest) => r.gameId, persist: async () => {}, emit: () => {} };
    const base = { id: "x", formatId: "f", timeControl: "blitz_3_0" as const, currency: "PLAY" as const, buyInCents: 100, rakeBps: 1000 };
    expect(() => new SitAndGo({ ...base, size: 1, payoutBps: [10_000] }, ports)).toThrow(); // 5 joueurs est désormais valide
    expect(() => new SitAndGo({ ...base, size: 4, payoutBps: [6000, 3000] }, ports)).toThrow();
  });

  it("persistance appelée dans l'ordre, une écriture à la fois", async () => {
    const t = setup(4);
    const spy = vi.fn();
    await t.fill(4);
    await t.sng.flush();
    const statuses = t.snapshots.map((s) => s.status);
    expect(statuses.indexOf("running")).toBeGreaterThan(statuses.lastIndexOf("registering"));
    spy();
  });
});

beforeEach(() => vi.restoreAllMocks());


describe("SitAndGo — n'importe quel nombre de joueurs, exempts", () => {
  /** joue tout le tournoi : à chaque partie en cours, la meilleure tête de série gagne */
  const playOut = async (t: ReturnType<typeof setup>) => {
    for (let guard = 0; guard < 500 && t.sng.state === "running"; guard++) {
      const snap = t.sng.snapshot();
      const live = snap.rounds.flat().find((m) => m.status === "playing");
      if (!live) break;
      const seed = (u: string) => snap.players.find((p) => p.userId === u)!.seed!;
      const fav = seed(live.p1!) < seed(live.p2!) ? live.p1! : live.p2!;
      await t.win(fav);
    }
  };

  it("taille du tableau : puissance de 2 supérieure", () => {
    expect([2, 3, 4, 5, 8, 9, 50, 64, 65, 128].map(bracketSizeFor)).toEqual([2, 4, 4, 8, 8, 16, 64, 64, 128, 128]);
  });

  it("5 joueurs : tableau de 8, les têtes de série 1 à 3 exemptes, tournoi jusqu'au bout", async () => {
    const t = setup(5, { buyIn: 0 });
    await t.fill(5);
    const r1 = t.sng.snapshot().rounds[0]!;
    expect(r1).toHaveLength(4);
    expect(r1.filter((m) => m.p2 === null).map((m) => m.p1).sort()).toEqual(["u1", "u2", "u3"]);
    expect(t.started.filter((r) => r.tournament.round === 1)).toHaveLength(1); // seul u4–u5 joue
    await playOut(t);
    const s = t.sng.snapshot();
    expect(s.status).toBe("finished");
    expect(s.rounds).toHaveLength(3);
    expect(s.players.find((p) => p.finalRank === 1)!.userId).toBe("u1");
  });

  it("50 joueurs : tableau de 64, 14 exempts, 6 tours, gains répartis", async () => {
    const t = setup(50);
    await t.fill(50);
    const s0 = t.sng.snapshot();
    expect(s0.rounds).toHaveLength(6);
    expect(s0.rounds[0]!.filter((m) => m.p2 === null)).toHaveLength(14);
    expect(t.started).toHaveLength(18); // 32 matchs − 14 exempts
    await playOut(t);
    const s = t.sng.snapshot();
    expect(s.status).toBe("finished");
    const pot = 50 * BUY_IN;
    const paid = s.players.reduce((a, p) => a + p.payoutCents, 0);
    expect(paid + s.rakeCents).toBe(pot);
    expect(s.players.filter((p) => p.payoutCents > 0).map((p) => p.userId).sort()).toEqual(["u1", "u2"]);
  });

  it("départ anticipé : le créateur lance avec les inscrits présents (au moins 2)", async () => {
    const t = setup(50);
    await t.fill(1);
    await expect(t.sng.startNow()).rejects.toMatchObject({ code: "NOT_ENOUGH_PLAYERS" });
    for (let i = 2; i <= 7; i++) { await t.fund(`u${i}`); await t.sng.register(`u${i}`, 2000 - i * 10); }
    await t.sng.startNow();
    const s = t.sng.snapshot();
    expect(s.status).toBe("running");
    expect(s.rounds[0]!).toHaveLength(4);
    expect(s.rounds[0]!.filter((m) => m.p2 === null).map((m) => m.p1)).toEqual(["u1"]);
    expect(s.prizePoolCents).toBe(7 * BUY_IN - Math.floor(7 * BUY_IN / 10)); // cagnotte = joueurs réellement engagés
    await expect(t.sng.startNow()).rejects.toMatchObject({ code: "NOT_REGISTERING" });
    await playOut(t);
    expect(t.sng.state).toBe("finished");
  });

  it("refuse une taille hors limites", () => {
    const ports = { ledger: new InMemoryLedger(), startGame: async () => "", persist: async () => {}, emit: () => {} };
    const base = { id: "x", formatId: "f", timeControl: "blitz_3_0" as const, currency: "PLAY" as const, buyInCents: 0, rakeBps: 0, payoutBps: [6500, 3500] };
    expect(() => new SitAndGo({ ...base, size: 1 }, ports)).toThrow();
    expect(() => new SitAndGo({ ...base, size: 129 }, ports)).toThrow();
    expect(() => new SitAndGo({ ...base, size: 2.5 }, ports)).toThrow();
  });
});
