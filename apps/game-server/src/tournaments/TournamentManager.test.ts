import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CUSTOM_LIMITS, CustomTournamentError, TournamentManager } from "./TournamentManager.js";
import { OFFICIAL_CREATOR } from "@chessarena/shared";
import type { OfficialSpec } from "./official.js";
import { InMemoryTournamentStore } from "./TournamentStore.js";
import { acct, InMemoryLedger } from "../settlement/ledger.js";
import type { StartGameRequest } from "./SitAndGo.js";

const H = 60 * 60_000;

function setup(inGame: Set<string> = new Set()) {
  const ledger = new InMemoryLedger();
  const store = new InMemoryTournamentStore();
  const started: StartGameRequest[] = [];
  const deps = {
    ledger, store, rakeBps: 1000,
    startGame: async (r: StartGameRequest) => { started.push(r); return r.gameId; },
    emitTournament: () => {}, emitLobby: () => {},
    isInGame: (u: string) => inGame.has(u),
  };
  const m = new TournamentManager([], deps);
  return { m, ledger, store, started, deps };
}
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("tournois programmés", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-28T10:00:00Z")); });
  afterEach(() => vi.useRealTimers());

  it("complet avant l'heure : il attend son heure ; inscrits libres jusqu'à 5 min avant ; départ à l'heure", async () => {
    const { m, started } = setup();
    const s = await m.createCustom({ size: 4, timeControl: "blitz_3_0", buyInCents: 0, system: "swiss", startsAt: at(2 * H) }, "a", 1500);
    expect(s.startsAt).toBe("2026-11-28T12:00:00.000Z");
    for (const u of ["b", "c", "d"]) await m.registerById(s.id, u, 1500);
    expect(m.get(s.id)!.state).toBe("registering"); // complet, mais programmé
    expect(m.isBusy("b")).toBe(false); // libre pour un duel en attendant
    expect(m.activeFor("b")).toHaveLength(1); // mais pas pour un second tournoi
    await vi.advanceTimersByTimeAsync(2 * H - CUSTOM_LIMITS.freeUntilMs + 1_000);
    expect(m.isBusy("b")).toBe(true); // 5 min avant : plus de nouveau duel
    expect(started).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(CUSTOM_LIMITS.freeUntilMs);
    await flush();
    expect(m.get(s.id)!.state).toBe("running");
    expect(started).toHaveLength(2);
  });

  it("à l'heure dite avec moins de 3 inscrits : annulé (et remboursé)", async () => {
    const { m, ledger } = setup();
    await ledger.faucet("a", 1_000, "seed-a");
    const s = await m.createCustom({ size: 8, timeControl: "blitz_3_0", buyInCents: 100, startsAt: at(H) }, "a", 1500);
    expect(await ledger.balance(acct.user("a", "PLAY"), "PLAY")).toBe(900);
    await vi.advanceTimersByTimeAsync(H + 1_000);
    await flush();
    expect(m.get(s.id)!.snapshot()).toMatchObject({ status: "cancelled", cancelReason: "pas assez d'inscrits à l'heure du départ" });
    expect(await ledger.balance(acct.user("a", "PLAY"), "PLAY")).toBe(1_000);
  });

  it("un inscrit encore en partie à l'heure dite : le départ attend la fin de sa partie", async () => {
    const inGame = new Set(["c"]);
    const { m } = setup(inGame);
    const s = await m.createCustom({ size: 8, timeControl: "blitz_3_0", buyInCents: 0, startsAt: at(H) }, "a", 1500);
    for (const u of ["b", "c"]) await m.registerById(s.id, u, 1500);
    await vi.advanceTimersByTimeAsync(H + 1_000);
    expect(m.get(s.id)!.state).toBe("registering");
    inGame.clear();
    await vi.advanceTimersByTimeAsync(16_000);
    await flush();
    expect(m.get(s.id)!.state).toBe("running");
  });

  it("refuse une heure trop proche, trop lointaine (> 14 jours) ou illisible", async () => {
    const { m } = setup();
    for (const startsAt of [at(30_000), at(15 * 24 * H), "demain soir"]) {
      await expect(m.createCustom({ size: 4, timeControl: "blitz_3_0", buyInCents: 0, startsAt }, "a", 1500)).rejects.toBeInstanceOf(CustomTournamentError);
    }
  });
});

describe("reprise après redémarrage", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-28T10:00:00Z")); });
  afterEach(() => vi.useRealTimers());

  it("un tournoi en inscription est repris tel quel ; l'escrow reste juste (désinscription remboursée, réinscription payée)", async () => {
    const A = setup();
    await A.ledger.faucet("a", 1_000, "seed-a");
    await A.ledger.faucet("b", 1_000, "seed-b");
    const s = await A.m.createCustom({ size: 8, timeControl: "rapid_5_0", buyInCents: 100, name: "Club", system: "swiss", rounds: 3, startsAt: at(24 * H) }, "a", 1500);
    await A.m.registerById(s.id, "b", 1600);
    // b s'est déjà désinscrit puis réinscrit une fois avant l'arrêt (clés tunreg/tlock « 1 » et « 2 » consommées)
    await A.m.get(s.id)!.unregister("b");
    await A.m.registerById(s.id, "b", 1600);
    const snap = A.m.get(s.id)!.snapshot();

    // redémarrage : même grand livre (base), nouveau gestionnaire
    vi.setSystemTime(new Date("2026-11-28T11:00:00Z"));
    const B = setup();
    const ledger = A.ledger;
    const m = new TournamentManager([], { ...B.deps, ledger });
    const t = m.restoreCustom(snap)!;
    expect(t.snapshot()).toMatchObject({ id: s.id, name: "Club", system: "swiss", swissRounds: 3, startsAt: snap.startsAt, createdAt: snap.createdAt, status: "registering" });
    expect(t.snapshot().players.map((p) => p.userId).sort()).toEqual(["a", "b"]);
    expect(m.lobby().some((x) => x.id === s.id)).toBe(true);
    expect(await ledger.balance(t.escrowAccount, "PLAY")).toBe(200);
    // désinscription après reprise : vraiment remboursée (clé neuve)
    await t.unregister("b");
    expect(await ledger.balance(acct.user("b", "PLAY"), "PLAY")).toBe(1_000);
    // réinscription : vraiment payée
    await m.registerById(s.id, "b", 1600);
    expect(await ledger.balance(acct.user("b", "PLAY"), "PLAY")).toBe(900);
    expect(await ledger.balance(t.escrowAccount, "PLAY")).toBe(200);
    // un tournoi déjà repris, en cours ou d'un lobby n'est pas repris deux fois
    expect(m.restoreCustom(snap)).toBeNull();
    expect(m.restoreCustom({ ...snap, id: "x", status: "running" })).toBeNull();
  });
});

describe("séries hebdomadaires", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-28T10:00:00Z")); });
  afterEach(() => vi.useRealTimers());
  const next = (m: TournamentManager, not: string) => m.lobby().find((x) => x.id !== not && x.repeatWeekly);

  it("au départ, le tournoi de la semaine suivante est programmé (mêmes réglages, créateur inscrit)", async () => {
    const { m } = setup();
    const s = await m.createCustom({ size: 8, timeControl: "blitz_3_0", buyInCents: 0, name: "Club du samedi", system: "swiss", rounds: 4, startsAt: "2026-11-28T19:00:00Z", repeatWeekly: true }, "a", 1500);
    expect(s.repeatWeekly).toBe(true);
    for (const u of ["b", "c"]) await m.registerById(s.id, u, 1500);
    await vi.advanceTimersByTimeAsync(9 * H + 1_000);
    await flush();
    expect(m.get(s.id)!.state).toBe("running");
    const n = next(m, s.id)!;
    expect(n).toMatchObject({ name: "Club du samedi", system: "swiss", swissRounds: 4, startsAt: "2026-12-05T19:00:00.000Z", status: "registering", createdBy: "a" });
    expect(n.players.map((p) => p.userId)).toEqual(["a"]);
  });

  it("faute d'inscrits à l'heure, la série continue ; annulé par le créateur, elle s'arrête", async () => {
    const { m } = setup();
    const s = await m.createCustom({ size: 8, timeControl: "blitz_3_0", buyInCents: 0, system: "arena", arenaMinutes: 45, startsAt: "2026-11-28T19:00:00Z", repeatWeekly: true }, "a", 1500);
    await vi.advanceTimersByTimeAsync(9 * H + 1_000);
    await flush();
    const n = next(m, s.id)!;
    expect(n).toMatchObject({ system: "arena", arenaMinutes: 45, startsAt: "2026-12-05T19:00:00.000Z" });
    // le créateur quitte la semaine suivante : annulée, pas de troisième
    await m.unregister(n.id, "a");
    await flush();
    expect(m.lobby().filter((x) => x.repeatWeekly)).toHaveLength(0);
  });

  it("une série sans heure de départ est refusée", async () => {
    const { m } = setup();
    await expect(m.createCustom({ size: 8, timeControl: "blitz_3_0", buyInCents: 0, repeatWeekly: true }, "a", 1500)).rejects.toBeInstanceOf(CustomTournamentError);
  });
});

describe("tournois officiels", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-28T10:00:00Z")); });
  afterEach(() => vi.useRealTimers());
  const spec: OfficialSpec = { name: "Arena Blitz quotidienne", system: "arena", timeControl: "blitz_3_0", arenaMinutes: 45, size: 128, hour: 20, minute: 0, buyInCents: 0, addedCents: 0 };

  it("créés sans inscrit, une seule fois par édition, organisateur réservé ; on s'y inscrit et s'en désinscrit librement", async () => {
    const { m, store } = setup();
    const made = m.ensureOfficial(Date.now(), [spec]);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ createdBy: OFFICIAL_CREATOR, name: "Arena Blitz quotidienne", system: "arena", arenaMinutes: 45, startsAt: "2026-11-28T19:00:00.000Z", status: "registering", players: [] });
    expect(m.ensureOfficial(Date.now(), [spec])).toHaveLength(0); // idempotent
    await flush();
    expect((await store.load(made[0]!.id))?.status).toBe("registering"); // enregistré : le lien survit à une mise en ligne
    const id = made[0]!.id;
    await m.registerById(id, "b", 1500);
    await m.unregister(id, "b");
    expect(m.get(id)!.state).toBe("registering"); // vide, mais pas annulé
    // un joueur peut toujours créer son propre tournoi (les officiels ne comptent pas dans la limite)
    await expect(m.createCustom({ size: 8, timeControl: "blitz_3_0", buyInCents: 0 }, "a", 1500)).resolves.toBeTruthy();
  });

  it("à l'heure : l'Arena part avec ses inscrits, l'édition du lendemain est déjà là", async () => {
    const { m, started } = setup();
    const [s] = m.ensureOfficial(Date.now(), [spec]);
    for (const u of ["a", "b", "c", "d"]) await m.registerById(s!.id, u, 1500);
    await vi.advanceTimersByTimeAsync(9 * 3600_000 + 1_000);
    await flush();
    expect(m.get(s!.id)!.state).toBe("running");
    expect(started.length).toBeGreaterThanOrEqual(2);
    const next = m.ensureOfficial(Date.now(), [spec]);
    expect(next.map((x) => x.startsAt)).toEqual(["2026-11-29T19:00:00.000Z"]);
  });

  it("Arena officielle avec un seul inscrit : elle part quand même à l'heure ; un suisse officiel sans 3 inscrits est annulé", async () => {
    const { m } = setup();
    const swiss: OfficialSpec = { name: "Grand Suisse", system: "swiss", timeControl: "blitz_3_2", rounds: 5, size: 128, hour: 20, minute: 0, buyInCents: 0, addedCents: 0 };
    const [a, s] = m.ensureOfficial(Date.now(), [spec, { ...swiss, minute: 5 }]);
    await m.registerById(a!.id, "solo", 1500);
    await m.registerById(s!.id, "solo2", 1500);
    await vi.advanceTimersByTimeAsync(9 * 3600_000 + 10 * 60_000);
    await flush();
    expect(m.get(a!.id)!.state).toBe("running");
    expect(m.get(s!.id)!.snapshot().status).toBe("cancelled");
  });

  it("tournoi officiel payant : dotation garantie versée par le site, entrée payée ; reprise après redémarrage avec la dotation ; annulé : tout est rendu", async () => {
    const { m, ledger, store } = setup();
    const paid: OfficialSpec = { name: "Suisse Blitz du soir", system: "swiss", timeControl: "blitz_3_2", rounds: 5, size: 64, hour: 20, minute: 0, buyInCents: 500, addedCents: 5_000 };
    const [s] = m.ensureOfficial(Date.now(), [paid]);
    await flush(); await flush();
    const t = m.get(s!.id)!;
    expect(await ledger.balance(t.escrowAccount, "PLAY")).toBe(5_000);
    expect(t.snapshot()).toMatchObject({ buyInCents: 500, sponsorAddedCents: 5_000 });
    await ledger.faucet("ana", 1_000, "w");
    await m.registerById(s!.id, "ana", 1500);
    expect(await ledger.balance(acct.user("ana", "PLAY"), "PLAY")).toBe(500);
    // redémarrage : la dotation est reprise avec le tournoi
    const saved = (await store.load(s!.id))!;
    const B = setup();
    const m2 = new TournamentManager([], { ...B.deps, ledger, store });
    const t2 = m2.restoreCustom(saved)!;
    expect(t2.snapshot().sponsorAddedCents).toBe(5_000);
    expect(m2.ensureOfficial(Date.now(), [paid])).toHaveLength(0); // pas de doublon
    await t2.cancel("test");
    expect(await ledger.balance(acct.user("ana", "PLAY"), "PLAY")).toBe(1_000);
    expect(await ledger.balance(t2.escrowAccount, "PLAY")).toBe(0);
  });
});

