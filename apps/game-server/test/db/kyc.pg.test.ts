import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, pgAvailable, type TestDb } from "@chessarena/testkit/testDb";
import { ageOn, assertTransition, decide, KycError, KycService, signWebhook, verifyWebhook, type ProviderResult } from "../../src/auth/kyc.js";
import { acct, DepositBlockedError, PgLedger } from "../../src/settlement/ledger.js";
import { WithdrawalService } from "../../src/settlement/withdrawals.js";
import { NullAuditLog } from "../../src/audit/auditLog.js";

const NOW = new Date("2026-10-26T10:00:00Z");
const result = (userId: string, p: Partial<ProviderResult> = {}): ProviderResult => ({
  eventId: `evt_${userId}_${Math.random()}`, userId, providerRef: `ref_${userId}`, document: "approved",
  birthDate: "1995-04-12", country: "MT", ...p,
});

describe("KYC — politique (unitaire)", () => {
  it("transitions autorisées et interdites", () => {
    expect(() => assertTransition("unverified", "pending")).not.toThrow();
    expect(() => assertTransition("pending", "verified")).not.toThrow();
    expect(() => assertTransition("rejected", "pending")).not.toThrow();
    expect(() => assertTransition("unverified", "verified")).toThrow(KycError); // pas de raccourci
    expect(() => assertTransition("rejected", "verified")).toThrow(KycError);
  });

  it("âge révolu, anniversaire inclus", () => {
    expect(ageOn("2008-10-26", NOW)).toBe(18);
    expect(ageOn("2008-10-27", NOW)).toBe(17);
    expect(ageOn("2008-02-29", new Date("2026-02-28T00:00:00Z"))).toBe(17);
  });

  it("décisions : mineur rejeté, sanctions et PEP en revue humaine, document refusé", () => {
    expect(decide(result("a"), NOW)).toEqual({ to: "verified", reason: null, reviewRequired: false });
    expect(decide(result("a", { birthDate: "2009-01-01" }), NOW)).toMatchObject({ to: "rejected", reason: "MINOR" });
    expect(decide(result("a", { sanctionsHit: true }), NOW)).toEqual({ to: "pending", reason: "SANCTIONS_HIT", reviewRequired: true });
    expect(decide(result("a", { pepHit: true }), NOW)).toMatchObject({ to: "pending", reviewRequired: true });
    expect(decide(result("a", { document: "declined", declineReason: "EXPIRED" }), NOW)).toMatchObject({ to: "rejected", reason: "EXPIRED" });
    expect(decide(result("a", { country: undefined }), NOW)).toMatchObject({ to: "rejected", reason: "INCOMPLETE_DATA" });
  });

  it("webhook : signature HMAC, fraîcheur, comparaison à temps constant", () => {
    const secret = "whsec_test_0123456789";
    const body = JSON.stringify(result("a"));
    const h = signWebhook(secret, body, 1_800_000_000);
    expect(() => verifyWebhook(secret, body, h, 300, 1_800_000_100)).not.toThrow();
    expect(() => verifyWebhook(secret, body + " ", h, 300, 1_800_000_100)).toThrow(/BAD_SIGNATURE/);   // corps altéré
    expect(() => verifyWebhook("autre", body, h, 300, 1_800_000_100)).toThrow(/BAD_SIGNATURE/);       // mauvais secret
    expect(() => verifyWebhook(secret, body, h, 300, 1_800_000_400)).toThrow(/STALE_WEBHOOK/);        // rejeu tardif
    expect(() => verifyWebhook(secret, body, undefined)).toThrow(/BAD_SIGNATURE/);
    expect(() => verifyWebhook(secret, body, "t=1800000000,v1=zz")).toThrow(/BAD_SIGNATURE/);
    expect(() => KycService.parseWebhook({ eventId: "e", userId: "u", providerRef: "r", document: "maybe" })).toThrow(/BAD_PAYLOAD/);
  });
});

describe.skipIf(!pgAvailable())("KYC — workflow en base et blocages", () => {
  let db: TestDb;
  let kyc: KycService;
  let ledger: PgLedger;
  const audit = new NullAuditLog();
  const user = (id: string) => db.pool.query("INSERT INTO users (id, username) VALUES ($1, $1)", [id]);

  beforeAll(async () => {
    db = await createTestDb();
    kyc = new KycService(db.pool, undefined, audit, () => NOW);
    ledger = new PgLedger(db.pool);
  });
  afterAll(async () => { await db?.drop(); });

  it("UNVERIFIED → PENDING → VERIFIED, journalisé, rejeu du webhook sans effet", async () => {
    await user("k1");
    expect((await kyc.state("k1")).status).toBe("unverified");
    const s = await kyc.start("k1");
    expect(s.status).toBe("pending");
    expect(s.url).toMatch(/^https:\/\//);
    const r = result("k1");
    expect(await kyc.applyProviderResult(r)).toMatchObject({ to: "verified", duplicate: false });
    expect(await kyc.applyProviderResult(r)).toMatchObject({ duplicate: true });
    expect(await kyc.state("k1")).toMatchObject({ status: "verified", country: "MT" });
    const ev = await db.pool.query("SELECT from_status, to_status, actor FROM kyc_events WHERE user_id = 'k1' ORDER BY id");
    expect(ev.rows).toEqual([
      { from_status: "unverified", to_status: "pending", actor: "user" },
      { from_status: "pending", to_status: "verified", actor: "provider:sandbox" },
    ]);
    await expect(db.pool.query("UPDATE kyc_events SET to_status = 'verified'")).rejects.toThrow(/append-only/);
  });

  it("mineur : rejeté et verrouillé (pas de nouvelle tentative)", async () => {
    await user("kid");
    await kyc.start("kid");
    await kyc.applyProviderResult(result("kid", { birthDate: "2010-05-05" }));
    expect((await kyc.state("kid")).status).toBe("rejected");
    await expect(kyc.start("kid")).rejects.toMatchObject({ code: "MINOR_LOCKED" });
  });

  it("alerte sanctions : reste PENDING en revue ; un agent tranche, motif obligatoire", async () => {
    await user("aml");
    await kyc.start("aml");
    await kyc.applyProviderResult(result("aml", { sanctionsHit: true }));
    expect(await kyc.state("aml")).toMatchObject({ status: "pending", reviewRequired: true });
    await expect(kyc.review("aml", "agent-1", false, "")).rejects.toThrow();
    expect(await kyc.review("aml", "agent-1", false, "homonymie confirmée sur liste de gel")).toBe("rejected");
  });

  it("nombre de tentatives limité", async () => {
    await user("retry");
    for (let i = 0; i < 3; i++) {
      await kyc.start("retry");
      await kyc.applyProviderResult(result("retry", { document: "declined", declineReason: "BLURRY" }));
    }
    await expect(kyc.start("retry")).rejects.toMatchObject({ code: "TOO_MANY_ATTEMPTS" });
  });

  it("résultat reçu hors état PENDING : refusé", async () => {
    await user("odd");
    await expect(kyc.applyProviderResult(result("odd"))).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("BLOCAGES : sans KYC vérifié, ni dépôt (garde-fou SQL), ni retrait", async () => {
    await user("nokyc");
    await expect(ledger.post("dep-nokyc", "EUR", [
      { account: acct.pspIn(), amountCents: -50_00 }, { account: acct.user("nokyc", "EUR"), amountCents: 50_00 },
    ], { kind: "deposit", userId: "nokyc" })).rejects.toBeInstanceOf(DepositBlockedError);
    // compte vérifié puis repassé en revue : retrait refusé à la demande
    await user("rev");
    await kyc.start("rev");
    await kyc.applyProviderResult(result("rev"));
    await ledger.post("dep-rev", "EUR", [
      { account: acct.pspIn(), amountCents: -50_00 }, { account: acct.user("rev", "EUR"), amountCents: 50_00 },
    ], { kind: "test_seed", userId: "rev" });
    const wd = new WithdrawalService(db.pool, ledger);
    const w = await wd.request("rev", 20_00);
    await kyc.requireReverification("rev", "agent-2", "DOCUMENT_EXPIRED");
    expect(await wd.processOne(w.id)).toBe("held");                         // retenu tant que non revérifié
    await expect(wd.request("rev", 10_00)).rejects.toMatchObject({ code: "KYC_REQUIRED" });
    expect(await kyc.review("rev", "agent-2", true, "nouvelle pièce valide reçue")).toBe("verified");
    expect((await wd.process()).sent).toBe(1);                               // relâché automatiquement
  });
});
