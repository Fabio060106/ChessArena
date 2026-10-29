import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type { CaseDetail, CaseSummary, DecisionResult } from "@chessarena/shared";
import { createTestDb, pgAvailable, type TestDb } from "@chessarena/testkit/testDb";
import { createGameServer, type GameServer } from "../../src/app.js";
import { defaultConfig } from "../../src/config.js";
import { seedEur } from "../helpers.js";

const SECRET = "api-test-secret-api-test-secret-api";
let db: TestDb;
let server: GameServer;
let base = "";
const tok = (sub: string, role?: string) => jwt.sign({ sub, ...(role ? { role } : {}) }, SECRET);
const call = (path: string, token?: string, init: RequestInit = {}) =>
  fetch(base + path, { ...init, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });

describe.skipIf(!pgAvailable())("API REST : back-office et portefeuille", () => {
  beforeAll(async () => {
    db = await createTestDb();
    server = createGameServer({ ...defaultConfig, jwtSecret: SECRET, realMoneyEnabled: true, realMoneyCountries: ["MT"], withdrawalIntervalMs: 0, tournamentFormats: [] }, { pool: db.pool });
    base = `http://localhost:${await server.listen(0)}`;
  });
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  it("authentification et rôle modérateur exigés", async () => {
    expect((await call("/admin/anticheat/cases")).status).toBe(401);
    expect((await call("/admin/anticheat/cases", "garbage")).status).toBe(401);
    expect((await call("/admin/anticheat/cases", tok("joueur"))).status).toBe(403);
    expect((await call("/admin/anticheat/cases", tok("mod", "moderator"))).status).toBe(200);
  });

  it("dossier : liste, détail, décision (motif obligatoire), seconde décision refusée", async () => {
    await db.pool.query("INSERT INTO users (id, username) VALUES ('sus', 'sus')");
    const { caseId } = await server.enforcer!.apply({
      userId: "sus", level: "hold", score: 90, reasons: ["test"], gameIds: [randomUUID()], depth: 18, ruleVersion: "t", at: new Date().toISOString(),
    });
    const list = (await (await call("/admin/anticheat/cases?status=open", tok("mod", "moderator"))).json()) as CaseSummary[];
    expect(list.map((c) => c.id)).toContain(caseId);
    const detail = (await (await call(`/admin/anticheat/cases/${caseId}`, tok("mod", "moderator"))).json()) as CaseDetail;
    expect(detail).toMatchObject({ userId: "sus", level: "hold", accountState: "withdrawal_hold" });

    const path = `/admin/anticheat/cases/${caseId}/decision`;
    expect((await call(path, tok("mod", "moderator"), { method: "POST", body: JSON.stringify({ decision: "clean" }) })).status).toBe(400);
    expect((await call(path, tok("mod", "moderator"), { method: "POST", body: JSON.stringify({ decision: "pardon", note: "xxxxxxx" }) })).status).toBe(400);
    const ok = await call(path, tok("mod", "moderator"), { method: "POST", body: JSON.stringify({ decision: "clean", note: "revue complète, jeu humain" }) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as DecisionResult).decision).toBe("clean");
    expect((await call(path, tok("mod", "moderator"), { method: "POST", body: JSON.stringify({ decision: "cheat", note: "changement d'avis" }) })).status).toBe(409);
    expect((await call(`/admin/anticheat/cases/${randomUUID()}`, tok("mod", "moderator"))).status).toBe(404);
  });

  it("retrait : réponse identique pour un compte bloqué et un compte sain", async () => {
    for (const [u, st] of [["alice", "active"], ["mallory", "withdrawal_hold"]] as const) {
      await db.pool.query("INSERT INTO users (id, username, state) VALUES ($1, $1, $2)", [u, st]);
      await seedEur(db.pool, server.ledger, u, 50_00);
    }
    const ra = await call("/wallet/withdrawals", tok("alice"), { method: "POST", body: JSON.stringify({ amountCents: 20_00 }) });
    const rm = await call("/wallet/withdrawals", tok("mallory"), { method: "POST", body: JSON.stringify({ amountCents: 20_00 }) });
    expect([ra.status, rm.status]).toEqual([201, 201]);
    const [ja, jm] = [await ra.json(), await rm.json()] as Array<Record<string, unknown>>;
    expect({ ...jm, id: 0, createdAt: 0 }).toEqual({ ...ja, id: 0, createdAt: 0 });
    await server.withdrawals!.process();
    const [la, lm] = await Promise.all(["alice", "mallory"].map(async (u) => (await (await call("/wallet/withdrawals", tok(u))).json()) as Array<{ status: string }>));
    expect(la![0]!.status).toBe("sent");
    expect(lm![0]!.status).toBe("processing"); // retenu, mais affiché comme n'importe quel retrait en cours
    expect((await call("/wallet/withdrawals", tok("alice"), { method: "POST", body: JSON.stringify({ amountCents: 1 }) })).status).toBe(400);
  });

  it("jeu responsable : définition des limites (baisse immédiate, hausse à 48 h), validation stricte", async () => {
    await db.pool.query("INSERT INTO users (id, username, kyc) VALUES ('rg', 'rg', 'verified')");
    const put = (b: unknown, ct = "application/json") =>
      fetch(base + "/account/limits", { method: "PUT", headers: { "content-type": ct, authorization: `Bearer ${tok("rg")}` }, body: JSON.stringify(b) });
    expect((await put({ kind: "deposit_week", amountCents: 100_00 }, "text/plain")).status).toBe(415);
    expect((await put({ kind: "yolo", amountCents: 100 })).status).toBe(400);
    expect((await put({ kind: "deposit_week", amountCents: -5 })).status).toBe(400);
    expect((await put({ kind: "deposit_week", amountCents: 1.5 })).status).toBe(400);
    expect(await (await put({ kind: "deposit_week", amountCents: 100_00 })).json()).toEqual({ action: "set", amount: 100_00 });
    expect(await (await put({ kind: "deposit_week", amountCents: 50_00 })).json()).toEqual({ action: "decrease", amount: 50_00 });
    const inc = (await (await put({ kind: "deposit_week", amountCents: 300_00 })).json()) as { action: string; effectiveAt: string };
    expect(inc.action).toBe("increase_requested");
    expect(new Date(inc.effectiveAt).getTime()).toBeGreaterThan(Date.now() + 47 * 3_600_000);
    const view = await (await call("/account/compliance", tok("rg"))).json() as { kyc: string; limits: Array<{ kind: string; amountCents: number; pendingAmountCents: number }> };
    expect(view.kyc).toBe("verified");
    expect(view.limits[0]).toMatchObject({ kind: "deposit_week", amountCents: 50_00, pendingAmountCents: 300_00 });
    expect((await call("/account/self-exclusion", tok("rg"), { method: "POST", body: JSON.stringify({ days: 0 }) })).status).toBe(400);
  });

  it("retrait sans KYC vérifié : 403 KYC_REQUIRED", async () => {
    await db.pool.query("INSERT INTO users (id, username) VALUES ('nokyc-api', 'nokyc-api')");
    const r = await call("/wallet/withdrawals", tok("nokyc-api"), { method: "POST", body: JSON.stringify({ amountCents: 20_00 }) });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "KYC_REQUIRED" });
  });

  it("limitation de débit HTTP par IP (429 + Retry-After)", async () => {
    const statuses = await Promise.all(Array.from({ length: 80 }, () => call("/wallet/withdrawals", tok("alice")).then((r) => r.status)));
    expect(statuses).toContain(429);
  });
});
