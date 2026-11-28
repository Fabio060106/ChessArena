import { beforeEach, describe, expect, it, vi } from "vitest";
import { TIME_CONTROLS, type GameResult, type SngSnapshot } from "@chessarena/shared";
import { bracketOrder, bracketSizeFor, SitAndGo, SngError, type StartGameRequest } from "./SitAndGo.js";
import { acct, InMemoryLedger } from "../settlement/ledger.js";
import type { FinishedGame } from "../game/GameRoom.js";

const BUY_IN = 500;

function setup(size: number, opts: { buyIn?: number; random?: () => number; swiss?: number | true; payoutBps?: number[]; pause?: number; arena?: number; clock?: { t: number }; teams?: string[] } = {}) {
  const ledger = new InMemoryLedger();
  const started: StartGameRequest[] = [];
  const snapshots: SngSnapshot[] = [];
  const sng = new SitAndGo(
    { id: "T1", formatId: "f", size, timeControl: "blitz_3_0", currency: "PLAY", buyInCents: opts.buyIn ?? BUY_IN, rakeBps: 1000, payoutBps: opts.payoutBps ?? [6500, 3500],
      ...(opts.swiss ? { system: "swiss" as const, swissRounds: opts.swiss === true ? 0 : opts.swiss } : {}),
      ...(opts.arena ? { system: "arena" as const, arenaMinutes: opts.arena } : {}),
      ...(opts.teams ? { teamBattle: { leaders: 2, teams: opts.teams.map((x) => ({ slug: x, name: `Club ${x}` })) } } : {}) },
    {
      ledger,
      startGame: async (r) => { started.push(r); return r.gameId; },
      persist: async (s) => { snapshots.push(s); },
      emit: () => {},
      random: opts.random ?? (() => 0.1), // p1 a les Blancs en partie principale
      swissPauseMs: opts.pause,
      arenaTickMs: 0,
      ...(opts.clock ? { now: () => opts.clock!.t } : {}),
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

  it("départ anticipé : le créateur lance avec les inscrits présents (au moins 3)", async () => {
    const t = setup(50);
    await t.fill(2);
    await expect(t.sng.startNow()).rejects.toMatchObject({ code: "NOT_ENOUGH_PLAYERS" }); // 2 inscrits : pas assez
    for (let i = 3; i <= 7; i++) { await t.fund(`u${i}`); await t.sng.register(`u${i}`, 2000 - i * 10); }
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
    expect(() => new SitAndGo({ ...base, size: 2 }, ports)).toThrow(); // à 2, ce n'est pas un tournoi
    expect(() => new SitAndGo({ ...base, size: 129 }, ports)).toThrow();
    expect(() => new SitAndGo({ ...base, size: 2.5 }, ports)).toThrow();
  });
});

describe("SitAndGo — système suisse", () => {
  /** termine toutes les parties en cours de la ronde : le mieux classé gagne, sauf nulle demandée */
  const playRound = async (t: ReturnType<typeof setup>, draws: Set<string> = new Set()) => {
    const live = t.started.filter((r) => !t.snapshots.at(-1)!.rounds.flat().some((m) => m.games.some((g) => g.gameId === r.gameId && g.result)));
    const snap = t.sng.snapshot();
    const cur = snap.rounds.at(-1)!.filter((m) => m.status === "playing");
    for (const m of cur) {
      const g = m.games.at(-1)!;
      const req = live.find((r) => r.gameId === g.gameId)!;
      const key = [m.p1, m.p2].sort().join("-");
      const seed = (u: string) => snap.players.find((p) => p.userId === u)!.seed!;
      await t.finish(req, draws.has(key) ? "1/2-1/2" : seed(req.white.userId) < seed(req.black.userId) ? "1-0" : "0-1");
    }
  };

  it("5 joueurs : 4 rondes, un exempt par ronde, tout le monde joue, classement et gains au podium", async () => {
    const t = setup(5, { swiss: true, payoutBps: [5000, 3000, 2000] });
    await t.fill(5);
    let s = t.sng.snapshot();
    expect(s.system).toBe("swiss");
    expect(s.totalRounds).toBe(4);
    expect(s.status).toBe("running");
    expect(s.rounds).toHaveLength(1);
    expect(s.rounds[0]!.find((m) => m.result === "bye")!.p1).toBe("u5"); // le moins bien classé
    expect(t.started.every((r) => r.tournament.swiss === true && r.tournament.kind === "main")).toBe(true);

    for (let r = 1; r <= 4; r++) {
      s = t.sng.snapshot();
      expect(s.rounds).toHaveLength(r);
      expect(s.currentRound).toBe(r);
      await playRound(t);
    }
    s = t.sng.snapshot();
    expect(s.status).toBe("finished");
    const byes = s.rounds.flat().filter((m) => m.result === "bye").map((m) => m.p1);
    expect(new Set(byes).size).toBe(4);
    // le n°1 gagne tout : 4 points (3 victoires + exempt ou 4 victoires)
    const top = s.players.find((p) => p.finalRank === 1)!;
    expect(top.userId).toBe("u1");
    expect(top.points).toBe(4);
    expect(s.players.map((p) => p.finalRank).sort()).toEqual([1, 2, 3, 4, 5]);
    // argent : cagnotte nette 2 250 (5 × 500 − 10 %) → 1 125 / 675 / 450, escrow vidé
    const pay = Object.fromEntries(s.players.map((p) => [p.finalRank, p.payoutCents]));
    expect([pay[1], pay[2], pay[3], pay[4], pay[5]]).toEqual([1125, 675, 450, 0, 0]);
    expect(await t.ledger.balance(t.sng.escrowAccount, "PLAY")).toBe(0);
    expect(s.players.every((p) => p.status === "winner" || p.status === "eliminated")).toBe(true);
    // personne n'a rencontré deux fois le même adversaire
    for (const p of s.players) {
      const opp = s.rounds.flat().filter((m) => m.p2 && (m.p1 === p.userId || m.p2 === p.userId)).map((m) => (m.p1 === p.userId ? m.p2 : m.p1));
      expect(new Set(opp).size).toBe(opp.length);
    }
  });

  it("une nulle compte ½ point chacun et ne déclenche ni revanche ni Armageddon", async () => {
    const t = setup(4, { swiss: 2, buyIn: 0 });
    await t.fill(4);
    const r1 = t.sng.snapshot().rounds[0]!;
    const drawn = [r1[0]!.p1!, r1[0]!.p2!].sort().join("-");
    const before = t.started.length;
    await playRound(t, new Set([drawn]));
    const s = t.sng.snapshot();
    expect(s.rounds[0]![0]!.result).toBe("1/2-1/2");
    expect(s.rounds[0]![0]!.winner).toBeNull();
    expect(s.players.find((p) => p.userId === r1[0]!.p1)!.points).toBe(0.5);
    // ronde 2 appariée directement : 2 nouvelles parties, aucune revanche
    expect(s.rounds).toHaveLength(2);
    expect(t.started.length).toBe(before + 2);
    expect(t.started.every((r) => r.tournament.kind === "main")).toBe(true);
  });

  it("premier coup non joué : défaite du responsable (forfait), pas d'élimination ; sans responsable, la partie est rejouée", async () => {
    const t = setup(4, { swiss: 3, buyIn: 0 });
    await t.fill(4);
    const [a, b] = t.started;
    await t.finish(a!, "1/2-1/2", { aborted: true, abortedBy: "w", termination: "aborted" });
    let s = t.sng.snapshot();
    expect(s.rounds[0]![0]!.result).toBe("0-1");
    const n = t.started.length;
    await t.finish(b!, "1/2-1/2", { aborted: true, abortedBy: null, termination: "aborted" });
    expect(t.started.length).toBe(n + 1); // rejouée
    s = t.sng.snapshot();
    expect(s.rounds).toHaveLength(1);
    await t.finish(t.started.at(-1)!, "1-0");
    s = t.sng.snapshot();
    expect(s.rounds).toHaveLength(2);
    // le forfait ne sort personne : 4 joueurs encore appariés en ronde 2
    expect(s.rounds[1]!.flatMap((m) => [m.p1, m.p2]).filter(Boolean)).toHaveLength(4);
  });

  it("départ anticipé à 3 inscrits sur 8 : rondes ramenées à 2 (sans rencontre répétée)", async () => {
    const t = setup(8, { swiss: 5, buyIn: 0 });
    await t.fill(3);
    await t.sng.startNow();
    const s = t.sng.snapshot();
    expect(s.totalRounds).toBe(2);
    expect(s.rounds[0]!.filter((m) => m.p2).length).toBe(1);
  });

  it("pause entre les rondes : la ronde suivante est annoncée (nextRoundAt) puis appariée après le délai", async () => {
    const t = setup(4, { swiss: 2, buyIn: 0, pause: 60 });
    await t.fill(4);
    await playRound(t);
    let s = t.sng.snapshot();
    expect(s.rounds).toHaveLength(1);
    expect(s.nextRoundAt).toBeTruthy();
    await new Promise((r) => setTimeout(r, 120));
    s = t.sng.snapshot();
    expect(s.rounds).toHaveLength(2);
    expect(s.nextRoundAt).toBeUndefined();
    await playRound(t);
    expect(t.sng.snapshot().status).toBe("finished"); // pas de pause après la dernière ronde
  });

  it("refuse plus de 3 places payées, ou un nombre de rondes invalide", () => {
    expect(() => setup(8, { swiss: true, payoutBps: [4000, 3000, 2000, 1000] })).toThrow(SngError);
    expect(() => setup(8, { swiss: 99 })).toThrow(SngError);
  });
});

describe("SitAndGo — Arena", () => {
  const MIN = 60_000;
  /** parties en cours (pas encore terminées) */
  const live = (t: ReturnType<typeof setup>) => {
    const done = new Set(t.sng.snapshot().rounds.flat().flatMap((m) => m.games.filter((g) => g.result).map((g) => g.gameId)));
    return t.started.filter((r) => !done.has(r.gameId));
  };

  it("parties enchaînées : appariement des joueurs libres à chaque vague, série en feu, fin à l'heure, gains", async () => {
    const clock = { t: Date.parse("2026-11-28T20:00:00Z") };
    const t = setup(8, { arena: 30, clock, payoutBps: [5000, 3000, 2000] });
    await t.fill(4);
    expect(t.sng.state).toBe("registering"); // une arena ne part pas toute seule
    await t.sng.startNow();
    let s = t.sng.snapshot();
    expect(s).toMatchObject({ system: "arena", arenaMinutes: 30, status: "running", arenaEndsAt: "2026-11-28T20:30:00.000Z" });
    expect(live(t)).toHaveLength(2); // 4 joueurs : 2 parties tout de suite

    // u1 gagne trois fois de suite : 2, 2, puis 4 (en feu)
    for (let i = 0; i < 3; i++) {
      await t.win("u1");
      // l'autre partie se termine aussi pour libérer des adversaires
      for (const r of live(t)) if (r.white.userId !== "u1" && r.black.userId !== "u1") await t.finish(r, "1/2-1/2");
      clock.t += MIN;
      await t.sng.arenaTick();
    }
    s = t.sng.snapshot();
    const u1 = s.players.find((p) => p.userId === "u1")!;
    expect(u1.sheet).toEqual([2, 2, 4]);
    expect(u1.points).toBe(8);
    expect(u1.fire).toBe(true);
    // on ne rejoue pas tout de suite son dernier adversaire (4 joueurs : il y a toujours un autre choix)
    const games = s.rounds[0]!;
    for (const p of ["u1", "u2", "u3", "u4"]) {
      const opp = games.filter((m) => m.p1 === p || m.p2 === p).map((m) => (m.p1 === p ? m.p2 : m.p1));
      for (let i = 1; i < opp.length; i++) expect(opp[i]).not.toBe(opp[i - 1]);
    }

    // fin : plus de nouvel appariement après l'heure, les parties en cours comptent encore
    clock.t = Date.parse("2026-11-28T20:30:01Z");
    const before = t.started.length;
    await t.sng.arenaTick();
    expect(t.started.length).toBe(before);
    expect(t.sng.state).toBe("running"); // des parties sont encore en cours
    for (const r of live(t)) await t.finish(r, "1-0");
    s = t.sng.snapshot();
    expect(s.status).toBe("finished");
    expect(s.players.find((p) => p.finalRank === 1)!.userId).toBe("u1");
    // cagnotte nette : 4 × 500 − 10 % = 1 800 → 900 / 540 / 360 ; escrow vidé
    expect(s.players.filter((p) => p.payoutCents > 0).map((p) => p.payoutCents).sort((a, b) => b - a)).toEqual([900, 540, 360]);
    expect(await t.ledger.balance(t.sng.escrowAccount, "PLAY")).toBe(0);
  });

  it("arrivée en cours de route (payée), pause et reprise, plus d'arrivée dans la dernière minute", async () => {
    const clock = { t: Date.parse("2026-11-28T20:00:00Z") };
    const t = setup(8, { arena: 20, clock });
    await t.fill(3);
    await t.sng.startNow();
    expect(live(t)).toHaveLength(1); // 3 joueurs : un attend
    await t.fund("late");
    await t.sng.register("late", 1700);
    expect(await t.bal("late")).toBe(10_000 - 500);
    await t.sng.arenaTick();
    expect(live(t)).toHaveLength(2); // le retardataire est apparié avec celui qui attendait
    expect(t.sng.snapshot().players.find((p) => p.userId === "late")).toMatchObject({ status: "playing", points: 0 });

    // pause : plus d'adversaire pour u1 après sa partie
    await t.sng.setPaused("u1", true);
    for (const r of live(t)) await t.finish(r, "1-0");
    await t.sng.arenaTick();
    expect(live(t).some((r) => r.white.userId === "u1" || r.black.userId === "u1")).toBe(false);
    expect(t.sng.snapshot().players.find((p) => p.userId === "u1")!.paused).toBe(true);
    await t.sng.setPaused("u1", false);
    for (const r of live(t)) await t.finish(r, "1/2-1/2");
    await t.sng.arenaTick();
    expect(live(t).some((r) => r.white.userId === "u1" || r.black.userId === "u1")).toBe(true);

    clock.t = Date.parse("2026-11-28T20:19:30Z");
    await t.fund("trop-tard");
    await expect(t.sng.register("trop-tard", 1500)).rejects.toMatchObject({ code: "NOT_REGISTERING" });
  });

  it("premier coup non joué : 0 pour le responsable, l'adversaire garde sa série ; annulée sans responsable : rien ne compte", async () => {
    const clock = { t: Date.parse("2026-11-28T20:00:00Z") };
    const t = setup(4, { arena: 30, clock, buyIn: 0 });
    await t.fill(2);
    await t.fund("u3"); await t.sng.register("u3", 1500);
    await t.sng.startNow();
    const [g] = live(t);
    const culprit = g!.white.userId;
    await t.finish(g!, "1/2-1/2", { aborted: true, abortedBy: "w", termination: "aborted" });
    let p = t.sng.snapshot().players.find((x) => x.userId === culprit)!;
    expect(p.sheet).toEqual([0]);
    const other = t.sng.snapshot().players.find((x) => x.userId === g!.black.userId)!;
    expect(other.sheet).toEqual([]);
    clock.t += MIN;
    await t.sng.arenaTick();
    const [g2] = live(t);
    await t.finish(g2!, "1/2-1/2", { aborted: true, abortedBy: null, termination: "aborted" });
    p = t.sng.snapshot().players.find((x) => x.userId === g2!.white.userId)!;
    expect(p.sheet!.length).toBeLessThanOrEqual(1);
    expect(t.sng.snapshot().players.reduce((a, x) => a + (x.points ?? 0), 0)).toBe(0);
  });

  it("berserk : la victoire vaut un point de plus, noté dans la partie (et conservé dans l'instantané)", async () => {
    const clock = { t: Date.parse("2026-11-28T20:00:00Z") };
    const t = setup(4, { arena: 30, clock, buyIn: 0 });
    await t.fill(3);
    await t.sng.startNow();
    const [g] = live(t);
    await t.finish(g!, "1-0", { berserk: { w: true, b: false }, moveTimesMs: new Array(20).fill(1000) });
    const s = t.sng.snapshot();
    expect(s.players.find((x) => x.userId === g!.white.userId)!.sheet).toEqual([3]);
    expect(s.rounds[0]![0]!.games[0]).toMatchObject({ berserk: { w: true, b: false }, plies: 20 });
  });

  it("Arena officielle : part sans inscrit, on la rejoint en cours ; finie à 2 joueurs : gains ajustés ; vide : annulée", async () => {
    const clock = { t: Date.parse("2026-11-28T20:00:00Z") };
    const t = setup(128, { arena: 20, clock, buyIn: 100, payoutBps: [5000, 3000, 2000] });
    await expect(t.sng.startNow()).rejects.toBeInstanceOf(SngError); // règle normale : 3 inscrits
    await t.sng.startNow(0);
    expect(t.sng.state).toBe("running");
    for (const u of ["a", "b"]) { await t.fund(u); await t.sng.register(u, 1500); }
    clock.t += MIN;
    await t.sng.arenaTick();
    const [g] = live(t);
    await t.finish(g!, "1-0");
    clock.t += 25 * MIN;
    await t.sng.arenaTick();
    const s = t.sng.snapshot();
    expect(s.status).toBe("finished");
    expect(s.players.map((p) => p.finalRank).sort()).toEqual([1, 2]);
    // pot 200 − 10 % = 180 : 62,5 % / 37,5 %
    expect(s.players.find((p) => p.finalRank === 1)!.payoutCents).toBe(113);
    expect(s.players.find((p) => p.finalRank === 2)!.payoutCents).toBe(67);

    const c2 = { t: Date.parse("2026-11-28T20:00:00Z") };
    const e2 = setup(128, { arena: 20, clock: c2, buyIn: 0 });
    await e2.sng.startNow(0);
    c2.t += 21 * MIN;
    await e2.sng.arenaTick();
    expect(e2.sng.snapshot()).toMatchObject({ status: "cancelled", cancelReason: "aucune partie jouée" });
  });

  it("départ à moins de 3 refusé hors Arena", async () => {
    const t = setup(8, { swiss: 3 });
    await expect(t.sng.startNow(0)).rejects.toBeInstanceOf(SngError);
  });

  it("refuse une durée d'arena non proposée", () => {
    expect(() => setup(8, { arena: 17 })).toThrow(SngError);
  });
});

describe("SitAndGo — bataille de clubs", () => {
  it("inscription avec son club, appariements entre clubs uniquement, scores des clubs dans l'instantané", async () => {
    const clock = { t: Date.parse("2026-11-28T20:00:00Z") };
    const t = setup(8, { arena: 30, clock, teams: ["fous", "tours"], buyIn: 0 });
    for (const [u, team] of [["f1", "fous"], ["f2", "fous"], ["t1", "tours"], ["t2", "tours"]] as const) { await t.fund(u); await t.sng.register(u, 1500, team); }
    await t.fund("x");
    await expect(t.sng.register("x", 1500, null)).rejects.toMatchObject({ code: "NOT_CLUB_MEMBER" });
    await expect(t.sng.register("x", 1500, "autre")).rejects.toMatchObject({ code: "NOT_CLUB_MEMBER" });
    await t.sng.startNow();
    expect(t.started).toHaveLength(2);
    for (const r of t.started) expect(r.white.userId[0]).not.toBe(r.black.userId[0]); // jamais f contre f
    // les fous gagnent tout
    for (const r of [...t.started]) await t.finish(r, r.white.userId.startsWith("f") ? "1-0" : "0-1");
    const s = t.sng.snapshot();
    expect(s.teamBattle!.leaders).toBe(2);
    expect(s.teamBattle!.teams.map((x) => [x.slug, x.score, x.players])).toEqual([["fous", 4, 2], ["tours", 0, 2]]);
    expect(s.players.find((p) => p.userId === "f1")!.team).toBe("fous");
  });

  it("une bataille de clubs est forcément une arena, avec 2 à 8 clubs", () => {
    expect(() => setup(8, { swiss: true, teams: ["a", "b"] })).toThrow(SngError);
    expect(() => setup(8, { arena: 30, teams: ["a"] })).toThrow(SngError);
  });
});

describe("SitAndGo — absents et départs", () => {
  it("suisse : deux forfaits de suite → retiré des appariements (garde ses points) ; départ volontaire", async () => {
    const t = setup(8, { swiss: 4, buyIn: 0 });
    await t.fill(5); // 5 joueurs : 4 rondes possibles
    await t.sng.startNow();
    // u? absent : il ne joue jamais son premier coup
    const absent = "u2"; // bien classé : jamais exempt, il a bien des parties à rater
    const play = async () => {
      const done = new Set(t.sng.snapshot().rounds.flat().flatMap((m) => m.games.filter((g) => g.result).map((g) => g.gameId)));
      for (const r of t.started.filter((x) => !done.has(x.gameId))) {
        if (r.white.userId === absent || r.black.userId === absent) await t.finish(r, "1/2-1/2", { aborted: true, abortedBy: r.white.userId === absent ? "w" : "b", termination: "aborted" });
        else await t.finish(r, "1-0");
      }
    };
    await play(); // ronde 1 : forfait n°1
    expect(t.sng.snapshot().players.find((p) => p.userId === absent)!.withdrawn).toBeUndefined();
    await play(); // ronde 2 : forfait n°2 → retiré
    let s = t.sng.snapshot();
    expect(s.players.find((p) => p.userId === absent)!.withdrawn).toBe(true);
    expect(s.rounds[2]!.some((m) => m.p1 === absent || m.p2 === absent)).toBe(false); // ronde 3 sans lui
    expect(s.rounds[2]!.filter((m) => m.p2).length).toBe(2); // 4 joueurs restants : 2 parties
    expect(t.sng.hasPlayer(absent)).toBe(false); // libre pour jouer ailleurs
    // départ volontaire d'un autre joueur
    const leaver = "u1";
    await t.sng.withdraw(leaver);
    await play();
    s = t.sng.snapshot();
    expect(s.rounds[3]!.some((m) => m.p1 === leaver || m.p2 === leaver)).toBe(false);
    await play();
    expect(t.sng.snapshot().status).toBe("finished");
    expect(t.sng.snapshot().players.every((p) => p.finalRank)).toBe(true); // les retirés restent classés
  });

  it("arena : premier coup non joué → mis en pause automatiquement (il reprend d'un clic)", async () => {
    const clock = { t: Date.parse("2026-11-28T20:00:00Z") };
    const t = setup(8, { arena: 30, clock, buyIn: 0 });
    await t.fill(4);
    await t.sng.startNow();
    const r = t.started[0]!;
    await t.finish(r, "1/2-1/2", { aborted: true, abortedBy: "w", termination: "aborted" });
    expect(t.sng.snapshot().players.find((p) => p.userId === r.white.userId)!.paused).toBe(true);
    await t.sng.setPaused(r.white.userId, false);
    expect(t.sng.snapshot().players.find((p) => p.userId === r.white.userId)!.paused).toBeUndefined();
  });
});

describe("SitAndGo — organisateur", () => {
  it("retirer un inscrit avant le départ : remboursé, ne peut plus se réinscrire", async () => {
    const t = setup(8);
    await t.fill(4);
    expect(await t.bal("u3")).toBe(10_000 - BUY_IN);
    await t.sng.kick("u3");
    expect(await t.bal("u3")).toBe(10_000);
    expect(t.sng.hasPlayer("u3")).toBe(false);
    await expect(t.sng.register("u3", 1500)).rejects.toMatchObject({ code: "REMOVED_BY_ORGANIZER" });
    await t.sng.startNow();
    await expect(t.sng.kick("u1")).rejects.toMatchObject({ code: "NOT_REGISTERING" });
  });
});

describe("SitAndGo — reprise d'un tournoi en cours après redémarrage", () => {
  /** relance : nouvelle instance, même grand livre, à partir du dernier instantané */
  const reboot = async (t: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) => {
    const snap = t.sng.snapshot();
    const started: StartGameRequest[] = [];
    const cfgBase = { id: "T1", formatId: "f", size: snap.size, timeControl: snap.timeControl, currency: snap.currency, buyInCents: snap.buyInCents, rakeBps: snap.rakeBps, payoutBps: snap.payoutBps };
    const sng = new SitAndGo({ ...cfgBase, ...extra } as never, {
      ledger: t.ledger, startGame: async (r) => { started.push(r); return r.gameId; }, persist: async () => {}, emit: () => {}, random: () => 0.1, arenaTickMs: 0,
      ...(extra.clock ? { now: () => (extra.clock as { t: number }).t } : {}),
    });
    await sng.restoreRunning(snap);
    const finish = (req: StartGameRequest, result: GameResult) => sng.onGameFinished({
      gameId: req.gameId, white: req.white, black: req.black, timeControl: TIME_CONTROLS[req.timeControl], stake: { currency: "PLAY", buyInCents: 0 },
      result, termination: result === "1/2-1/2" ? "agreement" : "resignation", pgn: "", moveTimesMs: [], focusLoss: { w: 0, b: 0 }, aborted: false, abortedBy: null,
      rated: req.rated, tournament: req.tournament,
    });
    return { sng, started, finish };
  };

  it("suisse : ronde en cours reprise, partie terminée gardée, partie interrompue rejouée ; fin et gains normaux", async () => {
    const t = setup(8, { swiss: 3, payoutBps: [5000, 3000, 2000] });
    await t.fill(4);
    await t.sng.startNow();
    await t.finish(t.started[0]!, "1-0"); // une partie finie, l'autre interrompue par le redémarrage
    const B = await reboot(t, { system: "swiss", swissRounds: 3 });
    let s = B.sng.snapshot();
    expect(s.status).toBe("running");
    expect(s.rounds[0]!.filter((m) => m.status === "done")).toHaveLength(1);
    expect(B.started).toHaveLength(1); // seule la partie interrompue est rejouée
    expect(s.players.find((p) => p.userId === t.started[0]!.white.userId)!.points).toBe(1);
    // on joue jusqu'au bout
    for (let i = 0; i < 20 && B.sng.snapshot().status === "running"; i++) {
      const done = new Set(B.sng.snapshot().rounds.flat().flatMap((m) => m.games.filter((g) => g.result).map((g) => g.gameId)));
      for (const r of B.started.filter((x) => !done.has(x.gameId))) await B.finish(r, "1-0");
    }
    s = B.sng.snapshot();
    expect(s.status).toBe("finished");
    expect(s.rounds).toHaveLength(3);
    for (const p of s.players) { const opp = s.rounds.flat().filter((m) => m.p2 && (m.p1 === p.userId || m.p2 === p.userId)).map((m) => (m.p1 === p.userId ? m.p2 : m.p1)); expect(new Set(opp).size).toBe(opp.length); }
    expect(await t.ledger.balance(B.sng.escrowAccount, "PLAY")).toBe(0);
  });

  it("élimination directe : après une nulle, la partie rejouée est la revanche", async () => {
    const t = setup(4, { buyIn: 0 });
    await t.fill(4);
    const first = t.started[0]!;
    await t.finish(first, "1/2-1/2"); // nulle → revanche en cours, interrompue
    const B = await reboot(t);
    const replay = B.started.find((r) => [r.white.userId, r.black.userId].includes(first.white.userId))!;
    expect(replay.tournament.kind).toBe("rematch");
  });

  it("arena : reprise avec le temps restant, parties interrompues sans effet, fin à l'heure", async () => {
    const clock = { t: Date.parse("2026-11-28T20:00:00Z") };
    const t = setup(8, { arena: 30, clock, buyIn: 0 });
    await t.fill(4);
    await t.sng.startNow();
    await t.finish(t.started[0]!, "1-0");
    clock.t += 5 * 60_000;
    const B = await reboot(t, { system: "arena", arenaMinutes: 30, clock });
    let s = B.sng.snapshot();
    expect(s.arenaEndsAt).toBe("2026-11-28T20:30:00.000Z");
    expect(s.rounds[0]!.filter((m) => m.status === "done" && m.result === null)).toHaveLength(1); // l'interrompue : annulée, sans points
    expect(s.players.reduce((a, p) => a + (p.points ?? 0), 0)).toBe(2);
    expect(B.started.length).toBeGreaterThan(0); // nouveaux appariements tout de suite
    clock.t = Date.parse("2026-11-28T20:30:01Z");
    for (const r of [...B.started]) await B.finish(r, "1/2-1/2");
    await B.sng.arenaTick();
    s = B.sng.snapshot();
    expect(s.status).toBe("finished");
  });
});
