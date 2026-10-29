/**
 * Jeu responsable : rejet des dépôts et des mises au-delà des limites, contrôlé DANS la
 * transaction comptable (PgLedger.policy), sur PostgreSQL réel.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestDb, pgAvailable, type TestDb } from "@chessarena/testkit/testDb";
import { acct, lockStakes, PgLedger } from "../../src/settlement/ledger.js";
import { DepositService } from "../../src/settlement/deposits.js";
import { WithdrawalService } from "../../src/settlement/withdrawals.js";
import {
  classify, effectiveLimit, INCREASE_DELAY_MS, KycRequiredError, LimitExceededError, LimitsRequiredError, LimitsService,
  planLimitChange, SelfExcludedError,
} from "../../src/fairplay/limits.js";
import { SitAndGo, SngError } from "../../src/tournaments/SitAndGo.js";

const DAY = 24 * 3600 * 1000;

describe("limites — politique (unitaire)", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  it("baisse immédiate, hausse différée de 48 h, première limite immédiate", () => {
    expect(planLimitChange(null, 100_00, now)).toEqual({ action: "set", amount: 100_00 });
    expect(planLimitChange(100_00, 50_00, now)).toEqual({ action: "decrease", amount: 50_00 });
    expect(planLimitChange(100_00, 200_00, now)).toEqual({ action: "increase_requested", amount: 200_00, effectiveAt: new Date(now.getTime() + INCREASE_DELAY_MS) });
    expect(planLimitChange(100_00, 100_00, now)).toEqual({ action: "unchanged" });
  });
  it("une hausse ne s'applique qu'à échéance", () => {
    const row = { kind: "deposit_week" as const, amount_cents: "10000", pending_amount_cents: "50000", pending_effective_at: new Date(now.getTime() + 1) };
    expect(effectiveLimit(row, now)).toBe(10_000);
    expect(effectiveLimit(row, new Date(now.getTime() + 2))).toBe(50_000);
  });
  it("classification : seuls les dépôts et les mises EUR sont contrôlés", () => {
    const dep = classify({ key: "k", currency: "EUR", meta: { kind: "deposit" }, postings: [{ account: acct.pspIn(), amountCents: -500 }, { account: "user:a:EUR", amountCents: 500 }] });
    expect([...dep.deposits]).toEqual([["a", 500]]);
    const stake = classify({ key: "k", currency: "EUR", meta: { kind: "lock" }, postings: [{ account: "user:a:EUR", amountCents: -200 }, { account: "user:b:EUR", amountCents: -200 }, { account: "escrow:g:EUR", amountCents: 400 }] });
    expect([...stake.stakes]).toEqual([["a", 200], ["b", 200]]);
    expect(classify({ key: "k", currency: "PLAY", meta: { kind: "lock" }, postings: [{ account: "user:a:PLAY", amountCents: -200 }, { account: "escrow:g:PLAY", amountCents: 200 }] }).stakes.size).toBe(0);
    expect(classify({ key: "k", currency: "EUR", meta: { kind: "settle" }, postings: [{ account: "escrow:g:EUR", amountCents: -400 }, { account: "user:a:EUR", amountCents: 400 }] }).deposits.size).toBe(0);
  });
});

describe.skipIf(!pgAvailable())("limites — appliquées par le grand livre", () => {
  let db: TestDb;
  let clock = new Date();
  let limits: LimitsService;
  let ledger: PgLedger;
  let deposits: DepositService;
  const ref = () => `psp-${randomUUID()}`;

  async function player(id: string, opts: { deposit?: number; stakeWeek?: number; perEntry?: number; fund?: number } = {}) {
    await db.pool.query("INSERT INTO users (id, username, kyc) VALUES ($1, $1, 'verified')", [id]);
    if (opts.deposit) await limits.setLimit(id, "deposit_week", opts.deposit);
    if (opts.stakeWeek) await limits.setLimit(id, "stake_week", opts.stakeWeek);
    if (opts.perEntry) await limits.setLimit(id, "stake_per_entry", opts.perEntry);
    if (opts.fund) await deposits.credit(id, opts.fund, ref());
  }
  const bal = (u: string) => ledger.balance(acct.user(u, "EUR"), "EUR");

  beforeAll(async () => {
    db = await createTestDb();
    limits = new LimitsService(db.pool, undefined, () => clock);
    ledger = new PgLedger(db.pool, { policy: limits.ledgerPolicy });
    deposits = new DepositService(ledger);
  });
  afterAll(async () => { await db?.drop(); });

  describe("dépôts", () => {
    it("refusé tant qu'aucune limite de dépôt n'est définie (règle ANJ)", async () => {
      await player("d0");
      await expect(deposits.credit("d0", 20_00, ref())).rejects.toBeInstanceOf(LimitsRequiredError);
      expect(await bal("d0")).toBe(0);
    });

    it("plafond sur 7 jours glissants : le dépôt qui dépasse est REJETÉ, rien n'est crédité", async () => {
      await player("d1", { deposit: 100_00 });
      await deposits.credit("d1", 60_00, ref());
      await deposits.credit("d1", 40_00, ref());               // pile au plafond : accepté
      const err = await deposits.credit("d1", 5_00, ref()).catch((e) => e);
      expect(err).toBeInstanceOf(LimitExceededError);
      expect(err).toMatchObject({ kind: "deposit_week", limitCents: 100_00, usedCents: 100_00, attemptedCents: 5_00 });
      expect(await bal("d1")).toBe(100_00);
      // fenêtre glissante : 8 jours plus tard, le cumul est retombé à zéro
      clock = new Date(Date.now() + 8 * DAY);
      await deposits.credit("d1", 90_00, ref());
      clock = new Date();
      expect(await bal("d1")).toBe(190_00);
    });

    it("CONCURRENCE : 10 dépôts simultanés de 30 € sous un plafond de 100 € → exactement 3 passent", async () => {
      await player("race", { deposit: 100_00 });
      const r = await Promise.allSettled(Array.from({ length: 10 }, () => deposits.credit("race", 30_00, ref())));
      expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(3);
      for (const x of r) if (x.status === "rejected") expect(x.reason).toBeInstanceOf(LimitExceededError);
      expect(await bal("race")).toBe(90_00);
    });

    it("baisse immédiate ; hausse effective seulement après 48 h", async () => {
      await player("d2", { deposit: 100_00 });
      await deposits.credit("d2", 50_00, ref());
      expect(await limits.setLimit("d2", "deposit_week", 50_00)).toMatchObject({ action: "decrease" });
      await expect(deposits.credit("d2", 1_00 * 5, ref())).rejects.toBeInstanceOf(LimitExceededError);
      const inc = await limits.setLimit("d2", "deposit_week", 500_00);
      expect(inc.action).toBe("increase_requested");
      await expect(deposits.credit("d2", 10_00, ref())).rejects.toBeInstanceOf(LimitExceededError); // toujours 50 €
      clock = new Date(Date.now() + INCREASE_DELAY_MS - 60_000);
      await expect(deposits.credit("d2", 10_00, ref())).rejects.toBeInstanceOf(LimitExceededError); // 47 h 59
      clock = new Date(Date.now() + INCREASE_DELAY_MS + 60_000);
      await deposits.credit("d2", 10_00, ref());                                                 // 48 h 01
      clock = new Date();
      const v = await limits.view("d2");
      expect(v.limits.find((l) => l.kind === "deposit_week")).toMatchObject({ amountCents: 500_00, pendingAmountCents: null, usedCents: 60_00 });
      const ev = await db.pool.query("SELECT event FROM rg_events WHERE user_id = 'd2' ORDER BY id");
      expect(ev.rows.map((e) => e.event)).toEqual(["limit_set", "limit_decrease", "limit_increase_requested", "limit_increase_applied"]);
    });

    it("identité non vérifiée : refus par la politique du ledger (et par le garde-fou SQL)", async () => {
      await db.pool.query("INSERT INTO users (id, username) VALUES ('nk', 'nk')");
      await db.pool.query("INSERT INTO rg_limits (user_id, kind, amount_cents) VALUES ('nk', 'deposit_week', 10000)");
      await expect(deposits.credit("nk", 20_00, ref())).rejects.toBeInstanceOf(KycRequiredError);
    });

    it("rejeu d'un dépôt déjà crédité (même référence PSP) : sans effet, même plafond atteint", async () => {
      await player("d3", { deposit: 50_00 });
      const r = ref();
      await deposits.credit("d3", 50_00, r);
      expect((await deposits.credit("d3", 50_00, r)).status).toBe("duplicate");
      expect(await bal("d3")).toBe(50_00);
    });
  });

  describe("mises", () => {
    it("duel EUR : limite hebdomadaire et limite par partie ; si UN joueur dépasse, personne n'est débité", async () => {
      await player("s1", { deposit: 500_00, stakeWeek: 10_00, perEntry: 5_00, fund: 100_00 });
      await player("s2", { deposit: 500_00, stakeWeek: 100_00, fund: 100_00 });
      await lockStakes(ledger, randomUUID(), "EUR", 5_00, ["s1", "s2"]);
      await expect(lockStakes(ledger, randomUUID(), "EUR", 6_00, ["s1", "s2"])).rejects.toMatchObject({ kind: "stake_per_entry" });
      await lockStakes(ledger, randomUUID(), "EUR", 5_00, ["s1", "s2"]);                   // s1 : 10 € sur 7 jours
      const err = await lockStakes(ledger, randomUUID(), "EUR", 1_00, ["s1", "s2"]).catch((e) => e);
      expect(err).toMatchObject({ kind: "stake_week", usedCents: 10_00 });
      expect(await bal("s1")).toBe(90_00);
      expect(await bal("s2")).toBe(90_00);                                                 // pas débité non plus
    });

    it("mise refusée tant que la limite de mises n'est pas définie ; PLAY jamais concerné", async () => {
      await player("s3", { deposit: 100_00, fund: 50_00 });
      await expect(lockStakes(ledger, randomUUID(), "EUR", 1_00, ["s3"])).rejects.toBeInstanceOf(LimitsRequiredError);
      await ledger.faucet("s3", 1_000, "x");
      await lockStakes(ledger, randomUUID(), "PLAY", 500, ["s3"]);
    });

    it("tournoi EUR : inscription refusée au-delà de la limite (code clair), la place est libérée", async () => {
      await player("t1", { deposit: 100_00, stakeWeek: 3_00, fund: 50_00 });
      const sng = new SitAndGo(
        { id: randomUUID(), formatId: "eur4", size: 4, timeControl: "blitz_3_0", currency: "EUR", buyInCents: 5_00, rakeBps: 1000, payoutBps: [6500, 3500] },
        { ledger, startGame: async (r) => r.gameId, persist: async () => {}, emit: () => {} },
      );
      const e = await sng.register("t1", 1500).catch((x) => x);
      expect(e).toBeInstanceOf(LimitExceededError);
      expect(sng.registeredCount).toBe(0);
      expect(e).not.toBeInstanceOf(SngError);
    });
  });

  describe("auto-exclusion", () => {
    it("temporaire : bloque dépôts et mises, autorise le retrait du solde ; ne peut pas être raccourcie ; expire seule", async () => {
      await player("x1", { deposit: 200_00, stakeWeek: 100_00, fund: 80_00 });
      await expect(limits.selfExclude("x1", { durationMs: 3600_000 })).rejects.toThrow(/24 h à 12 mois/);
      await limits.selfExclude("x1", { durationMs: 7 * DAY });
      await expect(deposits.credit("x1", 10_00, ref())).rejects.toBeInstanceOf(SelfExcludedError);
      await expect(lockStakes(ledger, randomUUID(), "EUR", 1_00, ["x1"])).rejects.toBeInstanceOf(SelfExcludedError);
      expect(await limits.isExcluded("x1")).toBe(true);
      // le solde reste retirable
      const wd = new WithdrawalService(db.pool, ledger);
      const w = await wd.request("x1", 50_00);
      expect(await wd.processOne(w.id)).toBe("sent");
      // une demande plus courte ne raccourcit pas l'exclusion en cours
      await limits.selfExclude("x1", { durationMs: 2 * DAY });
      const until = (await db.pool.query("SELECT self_excluded_until FROM users WHERE id = 'x1'")).rows[0].self_excluded_until as Date;
      expect(until.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
      // à échéance, le compte redevient actif
      clock = new Date(Date.now() + 8 * DAY);
      expect(await limits.isExcluded("x1")).toBe(false);
      await deposits.credit("x1", 10_00, ref());
      clock = new Date();
    });

    it("définitive : compte clôturé, plus aucun jeu, mais le solde reste payable", async () => {
      await player("x2", { deposit: 200_00, stakeWeek: 100_00, fund: 40_00 });
      await limits.selfExclude("x2", { permanent: true });
      expect((await db.pool.query("SELECT state FROM users WHERE id = 'x2'")).rows[0].state).toBe("closed");
      clock = new Date(Date.now() + 400 * DAY);
      expect(await limits.isExcluded("x2")).toBe(true);
      clock = new Date();
      const wd = new WithdrawalService(db.pool, ledger);
      const w = await wd.request("x2", 40_00);
      expect(await wd.processOne(w.id)).toBe("sent");
    });

    it("un joueur en WITHDRAWAL_HOLD qui s'auto-exclut : exclu ET toujours retenu", async () => {
      await player("x3", { deposit: 200_00, stakeWeek: 100_00, fund: 40_00 });
      await db.pool.query("UPDATE users SET state = 'withdrawal_hold' WHERE id = 'x3'");
      await limits.selfExclude("x3", { durationMs: 30 * DAY });
      await expect(lockStakes(ledger, randomUUID(), "EUR", 1_00, ["x3"])).rejects.toBeInstanceOf(SelfExcludedError);
      const wd = new WithdrawalService(db.pool, ledger);
      const w = await wd.request("x3", 10_00);
      expect(await wd.processOne(w.id)).toBe("held");
    });
  });

  it("toutes ces opérations laissent le grand livre équilibré", async () => {
    const r = await ledger.reconcile();
    expect(r).toMatchObject({ cacheMismatches: 0, unbalancedTransactions: 0, negativeUsers: 0 });
    expect(r.totals.EUR).toBe(0);
  });
});
