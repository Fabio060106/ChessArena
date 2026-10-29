import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgAuditLog, verifyAuditTable } from "../../src/audit/auditLog.js";
import { PgLedger, acct } from "../../src/settlement/ledger.js";
import { createTestDb, pgAvailable, type TestDb } from "@chessarena/testkit/testDb";

let db: TestDb;

describe.skipIf(!pgAvailable())("PgAuditLog — chaîne SHA-256 dans PostgreSQL", () => {
  beforeAll(async () => { db = await createTestDb(); });
  afterAll(async () => { await db?.drop(); });

  it("écritures bufferisées, chaîne valide, tête à jour", async () => {
    const log = new PgAuditLog(db.pool, { flushIntervalMs: 5, batchSize: 50 });
    for (let i = 1; i <= 230; i++) log.append("game.move", { gameId: "g1", ply: i, uci: "e2e4", note: i % 7 === 0 ? "é€🎉" : null, f: 0.1 + 0.2 });
    await log.close();
    const v = await verifyAuditTable(db.pool, 64); // pages volontairement petites
    expect(v).toMatchObject({ ok: true, checked: 230 });
    const head = (await db.pool.query("SELECT seq FROM audit_head")).rows[0];
    expect(Number(head.seq)).toBe(230);
  });

  it("deux écrivains concurrents (deux instances) : une seule chaîne linéaire", async () => {
    const a = new PgAuditLog(db.pool, { flushIntervalMs: 1, batchSize: 7 });
    const b = new PgAuditLog(db.pool, { flushIntervalMs: 1, batchSize: 11 });
    for (let i = 0; i < 100; i++) {
      a.append("game.move", { src: "A", i });
      b.append("game.move", { src: "B", i });
    }
    await Promise.all([a.close(), b.close()]);
    const v = await verifyAuditTable(db.pool);
    expect(v).toMatchObject({ ok: true, checked: 430 });
  });

  it("les écritures du grand livre sont journalisées", async () => {
    const audit = new PgAuditLog(db.pool);
    const ledger = new PgLedger(db.pool, { audit });
    await ledger.faucet("aud", 500, "1");
    await audit.close();
    const r = await db.pool.query("SELECT payload FROM audit_log WHERE type = 'ledger.post' ORDER BY seq DESC LIMIT 1");
    expect(r.rows[0].payload).toMatchObject({ key: "faucet:aud:1", currency: "PLAY" });
    expect(r.rows[0].payload.postings).toContainEqual({ account: acct.user("aud", "PLAY"), amountCents: 500 });
    expect((await verifyAuditTable(db.pool)).ok).toBe(true);
  });

  it("UPDATE / DELETE refusés par la base", async () => {
    await expect(db.pool.query("UPDATE audit_log SET payload = '{}' WHERE seq = 1")).rejects.toThrow(/append-only/);
    await expect(db.pool.query("DELETE FROM audit_log WHERE seq = 1")).rejects.toThrow(/append-only/);
  });

  describe("falsification par un superutilisateur (triggers désactivés) : détectée", () => {
    it("modification d'un coup au milieu de la chaîne", async () => {
      await db.admin("ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable");
      await db.admin(`UPDATE audit_log SET payload = jsonb_set(payload, '{uci}', '"e2e5"') WHERE seq = 42`);
      await db.admin("ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable");
      expect(await verifyAuditTable(db.pool)).toMatchObject({ ok: false, brokenAt: 42, reason: expect.stringContaining("contenu modifié") });
      // remise en état pour la suite
      await db.admin("ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable");
      await db.admin(`UPDATE audit_log SET payload = jsonb_set(payload, '{uci}', '"e2e4"') WHERE seq = 42`);
      await db.admin("ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable");
      expect((await verifyAuditTable(db.pool)).ok).toBe(true);
    });

    it("suppression des dernières lignes (indétectable par la chaîne seule) : détectée par la tête", async () => {
      const max = Number((await db.pool.query("SELECT max(seq) AS m FROM audit_log")).rows[0].m);
      await db.admin("ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable");
      await db.admin("DELETE FROM audit_log WHERE seq > $1", [max - 3]);
      await db.admin("ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable");
      expect(await verifyAuditTable(db.pool)).toMatchObject({ ok: false, reason: expect.stringContaining("supprimées") });
    });

    it("suppression au milieu : trou de séquence détecté", async () => {
      await db.admin("ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable");
      await db.admin("DELETE FROM audit_log WHERE seq = 10");
      await db.admin("ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable");
      expect(await verifyAuditTable(db.pool)).toMatchObject({ ok: false, brokenAt: 10 });
    });
  });
});
