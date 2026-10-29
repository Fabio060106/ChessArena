import { afterEach, describe, expect, it, vi } from "vitest";
import type { Stake } from "@chessarena/shared";
import { Matchmaker, queueKey, type QueueTicket } from "./Matchmaker.js";

const play = (c = 0): Stake => ({ currency: "PLAY", buyInCents: c });
const eur = (c = 0): Stake => ({ currency: "EUR", buyInCents: c });

function setup(opts: { base?: number; widen?: number; max?: number } = {}) {
  let t = 0;
  const pairs: Array<[QueueTicket, QueueTicket]> = [];
  const mm = new Matchmaker((a, b) => pairs.push([a, b]), {
    autoTick: false, now: () => t, baseWindow: opts.base, widenPerSec: opts.widen, maxWindow: opts.max,
  });
  const ids = () => pairs.map((p) => p.map((x) => x.userId).sort().join("-"));
  return { mm, pairs, ids, advance: (ms: number) => { t += ms; } };
}

afterEach(() => vi.useRealTimers());

describe("Matchmaker — files séparées", () => {
  it("ne mélange jamais deux cadences", () => {
    const { mm, pairs } = setup();
    mm.enqueue({ userId: "a", rating: 1500, timeControl: "bullet_1_0", stake: play() });
    mm.enqueue({ userId: "b", rating: 1500, timeControl: "blitz_3_0", stake: play() });
    mm.enqueue({ userId: "c", rating: 1500, timeControl: "blitz_3_2", stake: play() });
    mm.enqueue({ userId: "d", rating: 1500, timeControl: "rapid_5_0", stake: play() });
    expect(mm.tick()).toBe(0);
    expect(pairs).toHaveLength(0);
    expect(Object.keys(mm.sizes())).toHaveLength(4);
  });

  it("ne mélange jamais PLAY et EUR, ni deux mises différentes", () => {
    const { mm, ids } = setup();
    mm.enqueue({ userId: "p1", rating: 1500, timeControl: "blitz_3_0", stake: play(200) });
    mm.enqueue({ userId: "e1", rating: 1500, timeControl: "blitz_3_0", stake: eur(200) });
    mm.enqueue({ userId: "p2", rating: 1500, timeControl: "blitz_3_0", stake: play(500) });
    mm.enqueue({ userId: "p3", rating: 1500, timeControl: "blitz_3_0", stake: play(200) });
    mm.tick();
    expect(ids()).toEqual(["p1-p3"]);
    expect(queueKey("blitz_3_0", eur(200))).toBe("blitz_3_0|EUR|200");
  });
});

describe("Matchmaker — fenêtre Elo élargissante", () => {
  it("apparie immédiatement deux joueurs dans la fenêtre de base (±50)", () => {
    const { mm, ids } = setup();
    mm.enqueue({ userId: "a", rating: 1500, timeControl: "blitz_3_0", stake: play() });
    mm.enqueue({ userId: "b", rating: 1550, timeControl: "blitz_3_0", stake: play() });
    mm.tick();
    expect(ids()).toEqual(["a-b"]);
    expect(mm.isQueued("a")).toBe(false);
  });

  it("élargit de 25 Elo par seconde d'attente", () => {
    const { mm, pairs, advance } = setup();
    mm.enqueue({ userId: "a", rating: 1200, timeControl: "bullet_1_0", stake: play() });
    mm.enqueue({ userId: "b", rating: 1450, timeControl: "bullet_1_0", stake: play() });
    advance(7_999); // fenêtre 249,975 < 250
    mm.tick();
    expect(pairs).toHaveLength(0);
    advance(1); // fenêtre 250
    mm.tick();
    expect(pairs).toHaveLength(1);
  });

  it("plafonne la fenêtre à ±400", () => {
    const { mm, pairs, advance } = setup();
    mm.enqueue({ userId: "a", rating: 1000, timeControl: "blitz_3_0", stake: play() });
    mm.enqueue({ userId: "b", rating: 1401, timeControl: "blitz_3_0", stake: play() });
    advance(3_600_000);
    mm.tick();
    expect(pairs).toHaveLength(0);
  });

  it("exige que LES DEUX fenêtres acceptent l'écart", () => {
    const { mm, pairs, advance } = setup();
    mm.enqueue({ userId: "old", rating: 1500, timeControl: "blitz_3_0", stake: play() });
    advance(10_000); // fenêtre de "old" = 300
    mm.enqueue({ userId: "new", rating: 1700, timeControl: "blitz_3_0", stake: play() }); // fenêtre 50
    mm.tick();
    expect(pairs).toHaveLength(0);
    advance(6_000); // "new" : 50 + 150 = 200
    mm.tick();
    expect(pairs).toHaveLength(1);
  });

  it("choisit l'adversaire le plus proche en Elo, priorité au plus ancien", () => {
    const { mm, ids, advance } = setup({ base: 200 });
    mm.enqueue({ userId: "first", rating: 1500, timeControl: "blitz_3_0", stake: play() });
    advance(10);
    mm.enqueue({ userId: "far", rating: 1650, timeControl: "blitz_3_0", stake: play() });
    mm.enqueue({ userId: "near", rating: 1520, timeControl: "blitz_3_0", stake: play() });
    mm.enqueue({ userId: "mid", rating: 1600, timeControl: "blitz_3_0", stake: play() });
    mm.tick();
    expect(ids()).toEqual(["first-near", "far-mid"]);
  });

  it("apparie un grand nombre de joueurs sans doublon", () => {
    const { mm, pairs } = setup({ base: 800, max: 800 });
    for (let i = 0; i < 1000; i++) {
      mm.enqueue({ userId: `u${i}`, rating: 1000 + (i * 37) % 800, timeControl: "blitz_3_0", stake: play() });
    }
    mm.tick();
    const seen = pairs.flat().map((t) => t.userId);
    expect(new Set(seen).size).toBe(seen.length);
    expect(pairs.length).toBe(500);
  });
});

describe("Matchmaker — gestion de file", () => {
  it("refuse une double inscription, accepte après dequeue", () => {
    const { mm } = setup();
    mm.enqueue({ userId: "a", rating: 1500, timeControl: "blitz_3_0", stake: play() });
    expect(() => mm.enqueue({ userId: "a", rating: 1500, timeControl: "rapid_5_0", stake: play() })).toThrow("ALREADY_QUEUED");
    expect(mm.dequeue("a")).toBe(true);
    expect(mm.dequeue("a")).toBe(false);
    expect(mm.sizes()).toEqual({});
    mm.enqueue({ userId: "a", rating: 1500, timeControl: "rapid_5_0", stake: play() });
  });

  it("tick automatique toutes les secondes", () => {
    vi.useFakeTimers();
    const pairs: unknown[] = [];
    const mm = new Matchmaker(() => pairs.push(1));
    mm.enqueue({ userId: "a", rating: 1500, timeControl: "blitz_3_0", stake: play() });
    mm.enqueue({ userId: "b", rating: 1500, timeControl: "blitz_3_0", stake: play() });
    vi.advanceTimersByTime(999);
    expect(pairs).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(pairs).toHaveLength(1);
    mm.close();
  });

  it("une exception dans onMatch n'empêche pas les autres appariements", () => {
    const seen: string[] = [];
    const mm = new Matchmaker((a) => {
      seen.push(a.userId);
      if (seen.length === 1) throw new Error("boom");
    }, { autoTick: false });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const u of ["a", "b", "c", "d"]) mm.enqueue({ userId: u, rating: 1500, timeControl: "blitz_3_0", stake: play() });
    expect(mm.tick()).toBe(2);
    err.mockRestore();
  });
});
