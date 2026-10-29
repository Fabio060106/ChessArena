/**
 * Export réglementaire signé : contenu, intégrité (SHA-256 + Ed25519), détection de
 * falsification, neutralisation des formules CSV ; webhook KYC signé via l'API.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import { createTestDb, pgAvailable, type TestDb } from "@chessarena/testkit/testDb";
import {
  canonicalJson, csvCell, ExportError, keyFingerprint, RegulatoryExporter, toCsv, verifyExport, writeExportDir, type ExportBundle,
} from "../../src/audit/regulatoryExport.js";
import { acct, PgLedger } from "../../src/settlement/ledger.js";
import { LimitsService } from "../../src/fairplay/limits.js";
import { DepositService } from "../../src/settlement/deposits.js";
import { WithdrawalService } from "../../src/settlement/withdrawals.js";
import { KycService, signWebhook } from "../../src/auth/kyc.js";
import { PgAuditLog } from "../../src/audit/auditLog.js";
import { KillSwitch } from "../../src/net/geoFilter.js";
import { createGameServer } from "../../src/app.js";
import { defaultConfig } from "../../src/config.js";

describe("sérialisation", () => {
  it("JSON canonique : indépendant de l'ordre des clés", () => {
    expect(canonicalJson({ b: 1, a: [{ d: null, c: "x" }] })).toBe(canonicalJson({ a: [{ c: "x", d: null }], b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it("CSV : guillemets RFC 4180 et neutralisation des formules (OWASP)", () => {
    expect(csvCell("abc")).toBe("abc");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell("+33612345678")).toBe(`"'+33612345678"`);
    expect(csvCell("@SUM(A1)")).toBe(`"'@SUM(A1)"`);
    expect(csvCell("-1+1")).toBe(`"'-1+1"`);
    expect(csvCell(-1500)).toBe("-1500");                // un montant négatif reste un nombre
    expect(csvCell(null)).toBe("");
    expect(toCsv(["a", "b"], [{ a: 1, b: "x" }])).toBe("a,b\r\n1,x\r\n");
  });
});

describe.skipIf(!pgAvailable())("export réglementaire (PostgreSQL)", () => {
  let db: TestDb;
  let audit: PgAuditLog;
  let ledger: PgLedger;
  let exporter: RegulatoryExporter;
  let bundle: ExportBundle;
  const keys = generateKeyPairSync("ed25519");
  const privPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pubPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const t0 = new Date(Date.now() - 60_000);

  beforeAll(async () => {
    db = await createTestDb();
    audit = new PgAuditLog(db.pool);
    const limits = new LimitsService(db.pool, audit);
    ledger = new PgLedger(db.pool, { audit, policy: limits.ledgerPolicy });
    const kyc = new KycService(db.pool, undefined, audit);
    const deposits = new DepositService(ledger);
    exporter = new RegulatoryExporter(db.pool, audit, { signingKeyPem: privPem, production: true });

    // activité de la période : KYC, limites, dépôts, rake, retrait, kill-switch
    for (const u of ["alice", "=1+cmd|calc!A1"]) {
      await db.pool.query("INSERT INTO users (id, username) VALUES ($1, $1)", [u]);
      await kyc.start(u);
      await kyc.applyProviderResult({ eventId: `evt-${randomUUID()}`, userId: u, providerRef: "ref", document: "approved", birthDate: "1990-01-01", country: "MT" });
      await limits.setLimit(u, "deposit_week", 500_00);
      await deposits.credit(u, 100_00, `psp-${randomUUID()}`);
    }
    // rake d'un règlement (forme simplifiée d'un lot settle)
    await ledger.post(`settle:${randomUUID()}`, "EUR", [
      { account: acct.user("alice", "EUR"), amountCents: -10_00 }, { account: acct.rake("EUR"), amountCents: 10_00 },
    ], { kind: "settle", gameId: "g-1" });
    const wd = new WithdrawalService(db.pool, ledger);
    const w = await wd.request("alice", 30_00);
    await wd.processOne(w.id);
    await new KillSwitch(db.pool, audit, { envEnabled: true, envCountries: ["MT"] }).set("cmp", { enabled: true, countries: ["MT"] }, "ouverture");
    await audit.flush();

    bundle = await exporter.generate(t0, new Date(Date.now() + 60_000), "compliance-officer");
  });
  afterAll(async () => {
    await audit?.close();
    await db?.drop();
  });

  it("contenu : dépôts, retraits, rake, KYC, jeu responsable, kill-switch — totaux cohérents", () => {
    const m = bundle.manifest;
    expect(m.totals.deposits).toEqual({ rows: 2, sumCents: 200_00 });
    expect(m.totals.rake).toEqual({ rows: 1, sumCents: 10_00 });
    expect(m.totals.withdrawals).toEqual({ rows: 1, sumCents: 30_00 });
    expect(m.totals.kyc!.rows).toBe(4);                  // 2 × (unverified→pending, pending→verified)
    expect(m.totals.rg!.rows).toBe(2);
    expect(m.totals.compliance!.rows).toBe(1);
    expect(m.files.map((f) => f.name)).toContain("deposits.csv");
    expect(m.auditChain.verified).toBe(true);
    expect(m.auditChain.headSeq).toBeGreaterThan(0);
    expect(m.ledger).toEqual({ eurBalanced: true, unbalancedTransactions: 0 });
    expect(m.signature).toEqual({ algorithm: "Ed25519", keyFingerprint: keyFingerprint(pubPem), ephemeralKey: false });
    const wd = JSON.parse(bundle.files["withdrawals.json"]!) as { rows: Array<{ status: string }> };
    expect(wd.rows[0]!.status).toBe("sent");
  });

  it("injection de formule neutralisée dans le CSV (identifiant hostile)", () => {
    const csv = bundle.files["deposits.csv"]!;
    expect(csv).toContain(`"'=1+cmd|calc!A1"`);
    expect(csv.split("\r\n").some((l) => /(^|,)=/.test(l))).toBe(false);
  });

  it("vérification : paquet intact accepté avec la clé de confiance", () => {
    expect(verifyExport(bundle, keyFingerprint(pubPem))).toEqual({ ok: true, errors: [] });
  });

  it("FALSIFICATION détectée : un octet d'un CSV, un total du manifeste, une ligne retirée, une autre clé", () => {
    const csv = bundle.files["rake.csv"]!;
    const t1 = verifyExport({ ...bundle, files: { ...bundle.files, "rake.csv": csv.replace("1000", "100") } });
    expect(t1).toEqual({ ok: false, errors: ["empreinte invalide : rake.csv"] });

    const forged = JSON.parse(bundle.manifestJson);
    forged.totals.rake.sumCents = 1;
    const t2 = verifyExport({ ...bundle, manifestJson: canonicalJson(forged) });
    expect(t2.errors).toContain("signature du manifeste invalide");

    const { ["kyc.json"]: _drop, ...rest } = bundle.files;
    expect(verifyExport({ ...bundle, files: rest }).errors).toContain("fichier manquant : kyc.json");
    expect(verifyExport({ ...bundle, files: { ...bundle.files, "extra.csv": "x" } }).errors).toContain("fichier non déclaré : extra.csv");

    // faussaire qui re-signe un manifeste modifié avec SA clé : détecté par l'empreinte de confiance
    const evil = generateKeyPairSync("ed25519");
    const fx = new RegulatoryExporter(db.pool, undefined, { signingKeyPem: evil.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), production: true });
    return fx.generate(t0, new Date(Date.now() + 60_000), "faussaire").then((b) => {
      expect(verifyExport(b).ok).toBe(true);                                  // cohérent en interne…
      expect(verifyExport(b, keyFingerprint(pubPem)).errors).toEqual(["clé de signature non reconnue"]); // …mais pas la bonne clé
    });
  });

  it("période : bornes [from, to) respectées ; périodes invalides refusées", async () => {
    const before = await exporter.generate(new Date(t0.getTime() - 3_600_000), t0, "co");
    expect(before.manifest.totals.deposits).toEqual({ rows: 0, sumCents: 0 });
    await expect(exporter.generate(t0, t0, "co")).rejects.toMatchObject({ code: "BAD_PERIOD" });
    await expect(exporter.generate(new Date("2020-01-01"), new Date("2022-01-01"), "co")).rejects.toMatchObject({ code: "PERIOD_TOO_LONG" });
  });

  it("production sans clé : refus ; dev sans clé : clé éphémère signalée", async () => {
    await expect(new RegulatoryExporter(db.pool, undefined, { signingKeyPem: "", production: true }).generate(t0, new Date(), "x")).rejects.toBeInstanceOf(ExportError);
    const dev = await new RegulatoryExporter(db.pool, undefined, { signingKeyPem: "", production: false }).generate(t0, new Date(), "x");
    expect(dev.manifest.signature.ephemeralKey).toBe(true);
    expect(verifyExport(dev).ok).toBe(true);
    await expect(new RegulatoryExporter(db.pool, undefined, { signingKeyPem: "not a key", production: true }).generate(t0, new Date(), "x")).rejects.toMatchObject({ code: "BAD_KEY" });
  });

  it("registre des exports immuable + entrée dans la chaîne d'audit", async () => {
    await audit.flush();
    const r = await db.pool.query("SELECT generated_by, key_fingerprint FROM regulatory_exports WHERE id = $1", [bundle.manifest.exportId]);
    expect(r.rows[0]).toEqual({ generated_by: "compliance-officer", key_fingerprint: keyFingerprint(pubPem) });
    await expect(db.pool.query("DELETE FROM regulatory_exports")).rejects.toThrow();
    const a = await db.pool.query("SELECT payload FROM audit_log WHERE type = 'regulatory.export' AND payload->>'exportId' = $1", [bundle.manifest.exportId]);
    expect(a.rowCount).toBe(1);
  });

  it("écriture sur disque sans écrasement, relue et revérifiée", async () => {
    const dir = await mkdtemp(join(tmpdir(), "regexp-"));
    try {
      const names = await writeExportDir(bundle, dir);
      expect(names).toEqual(expect.arrayContaining(["manifest.json", "manifest.sig", "public_key.pem", "deposits.csv"]));
      await expect(writeExportDir(bundle, dir)).rejects.toThrow(/EEXIST/);
      const files: Record<string, string> = {};
      for (const f of bundle.manifest.files) files[f.name] = await readFile(join(dir, f.name), "utf8");
      const reread = {
        manifestJson: await readFile(join(dir, "manifest.json"), "utf8"),
        signatureB64: (await readFile(join(dir, "manifest.sig"), "utf8")).trim(),
        publicKeyPem: await readFile(join(dir, "public_key.pem"), "utf8"),
        files,
      };
      expect(verifyExport(reread, keyFingerprint(pubPem)).ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!pgAvailable())("API conformité : export et webhook KYC", () => {
  it("export réservé au rôle conformité ; webhook KYC authentifié par HMAC, rejeu sans effet", async () => {
    const db = await createTestDb();
    const SECRET = "api-compliance-secret-api-compliance";
    const HOOK = "whsec_" + "k".repeat(40);
    const s = createGameServer({ ...defaultConfig, jwtSecret: SECRET, kycWebhookSecret: HOOK, withdrawalIntervalMs: 0, tournamentFormats: [], httpRateLimit: { burst: 1000, perSecond: 1000 } }, { pool: db.pool });
    const base = `http://localhost:${await s.listen(0)}`;
    const tok = (sub: string, role?: string) => jwt.sign({ sub, ...(role ? { role } : {}) }, SECRET);
    const post = (p: string, body: unknown, headers: Record<string, string>) =>
      fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    try {
      const period = { from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() };
      expect((await post("/admin/compliance/exports", period, { authorization: `Bearer ${tok("mod", "moderator")}` })).status).toBe(403);
      const ok = await post("/admin/compliance/exports", period, { authorization: `Bearer ${tok("cmp", "compliance")}` });
      expect(ok.status).toBe(201);
      expect(verifyExport((await ok.json()) as ExportBundle).ok).toBe(true);
      const res = await fetch(base + "/admin/compliance/exports", { headers: { authorization: `Bearer ${tok("cmp", "compliance")}` } });
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");

      // KYC : le joueur (créé à sa 1re connexion) démarre, le prestataire notifie
      await db.pool.query("INSERT INTO users (id, username) VALUES ('kim', 'kim')");
      await fetch(base + "/kyc/start", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok("kim")}` } });
      const raw = JSON.stringify({ eventId: "evt-kim-1", userId: "kim", providerRef: "ref-kim", document: "approved", birthDate: "1992-03-04", country: "MT" });
      expect((await post("/kyc/webhook", raw, { "kyc-signature": "t=1,v1=00" })).status).toBe(401);
      expect((await post("/kyc/webhook", raw, { "kyc-signature": signWebhook("autre-secret", raw, Math.floor(Date.now() / 1000)) })).status).toBe(401);
      const sig = signWebhook(HOOK, raw, Math.floor(Date.now() / 1000));
      const first = await post("/kyc/webhook", raw, { "kyc-signature": sig });
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ received: true, duplicate: false });
      expect(await (await post("/kyc/webhook", raw, { "kyc-signature": sig })).json()).toEqual({ received: true, duplicate: true });
      const st = await (await fetch(base + "/kyc/status", { headers: { authorization: `Bearer ${tok("kim")}` } })).json();
      expect(st).toEqual({ status: "verified", attemptsLeft: 2 });
    } finally {
      await s.close();
      await db.drop();
    }
  });
});
