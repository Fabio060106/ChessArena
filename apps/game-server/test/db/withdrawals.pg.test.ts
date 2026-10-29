/**
 * Retraits et WITHDRAWAL_HOLD sur PostgreSQL réel.
 * Exigence : aucun euro ne sort pour un compte sous blocage — ni par le service, ni par
 * un contournement SQL, ni par une course entre l'exécution d'un retrait et le blocage.
 * Et rien ne doit permettre au joueur de deviner qu'il est sous blocage.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestDb, pgAvailable, type TestDb } from "@chessarena/testkit/testDb";
import { acct, PayoutBlockedError, PgLedger } from "../../src/settlement/ledger.js";
import { WithdrawalError, WithdrawalService, type Psp } from "../../src/settlement/withdrawals.js";
import { canPlay, type AuthUser } from "../../src/auth.js";
import { seedEur } from "../helpers.js";

let db: TestDb;
let ledger: PgLedger;
let svc: WithdrawalService;
const payouts: string[] = [];
const psp: Psp = { async payout(id) { payouts.push(id); return { pspRef: `ref-${id}` }; } };

async function player(id: string, eur: number, state: "active" | "withdrawal_hold" = "active") {
  await db.pool.query("INSERT INTO users (id, username, state) VALUES ($1, $1, $2)", [id, state]);
  if (eur > 0) await seedEur(db.pool, ledger, id, eur);
  else await db.pool.query("UPDATE users SET kyc = 'verified' WHERE id = $1", [id]);
}
const bal = (a: string) => ledger.balance(a, "EUR");
const status = async (id: string) => (await db.pool.query("SELECT status FROM withdrawal_requests WHERE id = $1", [id])).rows[0].status;
const hold = (u: string) => db.pool.query("UPDATE users SET state = 'withdrawal_hold' WHERE id = $1", [u]);

describe.skipIf(!pgAvailable())("retraits et WITHDRAWAL_HOLD", () => {
  beforeAll(async () => {
    db = await createTestDb();
    ledger = new PgLedger(db.pool);
    svc = new WithdrawalService(db.pool, ledger, psp);
  });
  afterAll(async () => { await db?.drop(); });

  it("compte actif : réservation à la demande, envoi à l'exécution", async () => {
    await player("ok", 50_00);
    const w = await svc.request("ok", 20_00);
    expect(w).toMatchObject({ amountCents: 2000, currency: "EUR", status: "processing" });
    expect(await bal(acct.user("ok", "EUR"))).toBe(30_00);          // plus misable ni retirable deux fois
    expect(await bal(acct.withdrawal(w.id))).toBe(20_00);
    expect(await svc.processOne(w.id)).toBe("sent");
    expect(await status(w.id)).toBe("sent");
    expect(await bal(acct.withdrawal(w.id))).toBe(0);
    expect(await bal(acct.pspOut())).toBe(20_00);
    expect(payouts).toContain(w.id);
    expect((await svc.list("ok"))[0]!.status).toBe("sent");
  });

  it("demandes invalides : montant, solde insuffisant, compte suspendu", async () => {
    await player("poor", 15_00);
    await expect(svc.request("poor", 5_00)).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await expect(svc.request("poor", 20_00)).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    await db.pool.query("INSERT INTO users (id, username, state) VALUES ('banned', 'banned', 'suspended')");
    await expect(svc.request("banned", 10_00)).rejects.toBeInstanceOf(WithdrawalError);
  });

  it("compte en WITHDRAWAL_HOLD : demande acceptée, exécution RETENUE, l'argent ne sort pas", async () => {
    await player("sus", 80_00, "withdrawal_hold");
    const w = await svc.request("sus", 50_00);
    expect(await svc.processOne(w.id)).toBe("held");
    expect(await status(w.id)).toBe("on_hold");
    expect(payouts).not.toContain(w.id);
    expect(await bal(acct.withdrawal(w.id))).toBe(50_00);           // fonds conservés en escrow
    // les exécutions suivantes ne le reprennent pas
    const r = await svc.process();
    expect(r.sent).toBe(0);
    expect(await status(w.id)).toBe("on_hold");
  });

  it("DISCRÉTION : la vue joueur d'un retrait retenu est indiscernable d'un retrait en cours", async () => {
    await player("honest", 80_00);
    await player("held", 80_00, "withdrawal_hold");
    const a = await svc.request("honest", 30_00);
    const b = await svc.request("held", 30_00);
    await svc.processOne(b.id); // → on_hold en interne
    const va = (await svc.list("honest"))[0]!;
    const vb = (await svc.list("held"))[0]!;
    const strip = (v: typeof va) => ({ ...v, id: "x", createdAt: "x" });
    expect(strip(vb)).toEqual(strip(va));
    expect(Object.keys(vb).sort()).toEqual(["amountCents", "createdAt", "currency", "id", "status"]);
    expect(JSON.stringify(vb)).not.toMatch(/hold|review|fair|cheat|suspend/i);
  });

  it("le JEU continue sous WITHDRAWAL_HOLD (PLAY et EUR), mais pas sous suspension", () => {
    const u: AuthUser = { userId: "sus", ratings: {} as AuthUser["ratings"], country: "MT", state: "withdrawal_hold", kycVerified: true };
    const rm = { mode: "REAL_MONEY", reason: "OK" } as const;
    expect(canPlay(u, "PLAY", rm)).toEqual({ ok: true });
    expect(canPlay(u, "EUR", rm)).toEqual({ ok: true });
    expect(canPlay({ ...u, state: "suspended" }, "PLAY", rm)).toEqual({ ok: false, code: "ACCOUNT_SUSPENDED" });
  });

  it("GARDE-FOU SQL : même en contournant le service, aucun paiement pour un compte bloqué", async () => {
    await player("bypass", 60_00);
    const w = await svc.request("bypass", 40_00);
    await hold("bypass");
    // tentative directe d'écriture comptable vers le prestataire
    await expect(ledger.post(`payout:${w.id}`, "EUR", [
      { account: acct.withdrawal(w.id), amountCents: -40_00 }, { account: acct.pspOut(), amountCents: 40_00 },
    ], { withdrawalId: w.id })).rejects.toBeInstanceOf(PayoutBlockedError);
    // sortie d'argent sans référence de retrait : refusée aussi
    await expect(ledger.post(`raw-out:${randomUUID()}`, "EUR", [
      { account: acct.user("ok", "EUR"), amountCents: -1_00 }, { account: acct.pspOut(), amountCents: 1_00 },
    ])).rejects.toBeInstanceOf(PayoutBlockedError);
    // passage forcé du statut à « sent »
    await expect(db.pool.query("UPDATE withdrawal_requests SET status = 'sent' WHERE id = $1", [w.id])).rejects.toThrow(/blocked: account withdrawal_hold/);
    expect(await bal(acct.withdrawal(w.id))).toBe(40_00);
  });

  it("COURSE : un blocage posé PENDANT l'exécution attend sa fin — jamais d'envoi après blocage", async () => {
    await player("racer", 60_00);
    const w = await svc.request("racer", 25_00);
    let pspCalled!: () => void;
    const inPsp = new Promise<void>((r) => (pspCalled = r));
    const slow = new WithdrawalService(db.pool, ledger, { async payout(id) { pspCalled(); await new Promise((r) => setTimeout(r, 400)); return { pspRef: `slow-${id}` }; } });
    const exec = slow.processOne(w.id);
    await inPsp;                                     // l'exécution est en cours, verrou posé
    const t0 = Date.now();
    await hold("racer");                             // doit attendre la fin de l'exécution
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(await exec).toBe("sent");
    const sentAt = (await db.pool.query("SELECT sent_at FROM withdrawal_requests WHERE id = $1", [w.id])).rows[0].sent_at as Date;
    expect(sentAt.getTime()).toBeLessThanOrEqual(Date.now());
    // le retrait suivant de ce joueur, lui, est retenu
    const w2 = await svc.request("racer", 10_00);
    expect(await svc.processOne(w2.id)).toBe("held");
  });

  it("levée du blocage : les retraits retenus repartent et sont envoyés ; un retrait envoyé est définitif", async () => {
    await player("cleared", 50_00, "withdrawal_hold");
    const w = await svc.request("cleared", 20_00);
    expect(await svc.processOne(w.id)).toBe("held");
    const c = await db.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("UPDATE users SET state = 'active' WHERE id = 'cleared'");
      expect(await svc.releaseWithin(c, "cleared")).toBe(1);
      await c.query("COMMIT");
    } finally { c.release(); }
    expect(await svc.processOne(w.id)).toBe("sent");
    await expect(db.pool.query("UPDATE withdrawal_requests SET status = 'cancelled' WHERE id = $1", [w.id])).rejects.toThrow(/already final/);
  });

  it("exécutions concurrentes du même lot : chaque retrait n'est payé qu'une fois", async () => {
    await player("multi", 100_00);
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await svc.request("multi", 10_00)).id);
    payouts.length = 0;
    await Promise.all([svc.process(), svc.process(), svc.process()]);
    for (const id of ids) expect(payouts.filter((p) => p === id)).toHaveLength(1);
    expect(await bal(acct.user("multi", "EUR"))).toBe(50_00);
    const rec = await ledger.reconcile();
    expect(rec).toMatchObject({ cacheMismatches: 0, unbalancedTransactions: 0, negativeUsers: 0 });
    expect(rec.totals.EUR).toBe(0);
  });
});
