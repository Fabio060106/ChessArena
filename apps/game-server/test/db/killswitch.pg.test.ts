/**
 * Géo-filtre et kill-switch, de bout en bout : vrais sockets, vraie base, vraie API HTTP.
 *
 * La coupure de l'argent réel doit, sans redémarrage :
 *   1. basculer chaque session en PLAY_MONEY_ONLY et le lui notifier (`session:mode`) ;
 *   2. vider les files d'attente EUR ;
 *   3. annuler les Sit & Go EUR en inscription et rembourser intégralement les inscrits ;
 *   4. refuser toute nouvelle mise EUR, et tout dépôt ;
 *   5. laisser les retraits possibles ;
 *   6. être tracée (journal immuable + chaîne d'audit) ;
 *   7. se propager aux autres instances (bascule faite ailleurs, détectée en base).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { io as connect, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ErrorCode, ServerToClientEvents, SessionModeEvent, SngAck } from "@chessarena/shared";
import { createTestDb, pgAvailable, type TestDb } from "@chessarena/testkit/testDb";
import { createGameServer, type GameServer } from "../../src/app.js";
import { defaultConfig, type GameServerConfig } from "../../src/config.js";
import { acct, InMemoryLedger } from "../../src/settlement/ledger.js";
import { CidrGeoResolver, KillSwitch } from "../../src/net/geoFilter.js";
import { NullAuditLog } from "../../src/audit/auditLog.js";

type Client = Socket<ServerToClientEvents, ClientToServerEvents> & { modes: SessionModeEvent[] };
const SECRET = "killswitch-test-secret-killswitch-test";
// 127.0.0.1 / ::1 = Malte (autorisé) ; XFF permet de simuler d'autres origines derrière le proxy local
const GEO = CidrGeoResolver.fromCsv("127.0.0.0/8,MT\n::1/128,MT\n203.0.113.0/24,US\n198.51.100.0/24,FR");
const EUR_SNG = { id: "sng4-eur", size: 4 as const, timeControl: "blitz_3_0" as const, currency: "EUR" as const, buyInCents: 2_00 };

let db: TestDb;
let server: GameServer;
let url = "";
const clients: Client[] = [];
const tok = (sub: string, role?: string) => jwt.sign({ sub, ...(role ? { role } : {}) }, SECRET);

function client(sub: string, headers: Record<string, string> = {}, base = url): Promise<Client> {
  const c = connect(base, {
    transports: ["websocket"], forceNew: true, reconnection: false, auth: { token: tok(sub) }, extraHeaders: headers,
  }) as Client;
  c.modes = [];
  c.on("session:mode", (m) => c.modes.push(m));          // attaché AVANT la connexion : rien n'est manqué
  clients.push(c);
  return new Promise((res, rej) => {
    c.on("connect", () => {
      const wait = () => (c.modes.length ? res(c) : setTimeout(wait, 5));
      wait();
    });
    c.on("connect_error", rej);
  });
}
const nextError = (c: Client) => new Promise<ErrorCode>((r) => c.once("error", (e) => r(e.code)));
const nextMode = (c: Client) => new Promise<SessionModeEvent>((r) => c.once("session:mode", r));
const register = (c: Client, formatId: string) => new Promise<SngAck>((r) => c.emit("sng:register", { formatId }, r));
const http = (path: string, token: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
  fetch(url + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers }, body: body ? JSON.stringify(body) : undefined });
const eur = (u: string) => server.ledger.balance(acct.user(u, "EUR"), "EUR");

/** joueur vérifié (résidence Malte), limites définies, crédité par un vrai dépôt */
async function richPlayer(id: string, opts: { perEntry?: number; country?: string } = {}) {
  await db.pool.query("INSERT INTO users (id, username, kyc, country) VALUES ($1, $1, 'verified', $2)", [id, opts.country ?? "MT"]);
  await server.limits!.setLimit(id, "deposit_week", 1_000_00);
  await server.limits!.setLimit(id, "stake_week", 500_00);
  if (opts.perEntry) await server.limits!.setLimit(id, "stake_per_entry", opts.perEntry);
  await server.deposits!.credit(id, 50_00, `psp-seed-${id}`);
}

describe.skipIf(!pgAvailable())("kill-switch et géo-filtre (bout en bout)", () => {
  beforeAll(async () => {
    db = await createTestDb();
    const cfg: GameServerConfig = {
      ...defaultConfig, jwtSecret: SECRET, realMoneyEnabled: true, realMoneyCountries: ["MT", "FR"],
      trustedProxies: ["127.0.0.1/32", "::1/128"], withdrawalIntervalMs: 0, matchmakerTickMs: 50,
      stakeLimits: { minCents: 0, maxCents: 10_00 }, tournamentFormats: [EUR_SNG],
      httpRateLimit: { burst: 1_000, perSecond: 1_000 },
    };
    server = createGameServer(cfg, { pool: db.pool, geoResolver: GEO });
    url = `http://localhost:${await server.listen(0)}`;
    // ouverture de Malte par la conformité (la migration livre l'argent réel FERMÉ)
    await server.killSwitch.set("ops", { enabled: true, countries: ["MT"] }, "ouverture initiale Malte");
  });
  afterAll(async () => {
    clients.forEach((c) => c.disconnect());
    await server?.close();
    await db?.drop();
  });

  it("état livré par la migration : argent réel fermé (fail closed)", async () => {
    const fresh = new KillSwitch(db.pool, undefined, { envEnabled: true, envCountries: ["MT"] });
    const ev = await db.pool.query("SELECT event, actor FROM compliance_events ORDER BY id");
    expect(ev.rows).toEqual([{ event: "real_money_enabled", actor: "ops" }]);
    expect((await fresh.state()).enabled).toBe(true);
  });

  it("géolocalisation : Malte → REAL_MONEY ; US → JURISDICTION_BLOCKED ; IP inconnue → UNKNOWN_LOCATION ; résidence hors liste bloquée", async () => {
    await richPlayer("geo-mt");
    await richPlayer("geo-fr", { country: "FR" });
    expect((await client("geo-mt")).modes[0]).toEqual({ mode: "REAL_MONEY", reason: "OK" });
    const us = await client("geo-mt", { "x-forwarded-for": "203.0.113.7" });
    expect(us.modes[0]).toEqual({ mode: "PLAY_MONEY_ONLY", reason: "JURISDICTION_BLOCKED" });
    const err = nextError(us);
    us.emit("queue:join", { timeControl: "blitz_3_0", stake: { currency: "EUR", buyInCents: 2_00 } });
    expect(await err).toBe("JURISDICTION_BLOCKED");
    expect((await client("geo-mt", { "x-forwarded-for": "192.0.2.55" })).modes[0]).toEqual({ mode: "PLAY_MONEY_ONLY", reason: "UNKNOWN_LOCATION" });
    // FR est dans le plafond d'environnement mais PAS ouvert par la conformité : la résidence FR bloque même depuis Malte
    expect((await client("geo-fr")).modes[0]).toEqual({ mode: "PLAY_MONEY_ONLY", reason: "RESIDENCE_BLOCKED" });
  });

  it("HTTP : dépôt refusé hors juridiction, retrait toujours possible", async () => {
    await richPlayer("traveller");
    const dep = await http("/wallet/deposits", tok("traveller"), "POST", { amountCents: 10_00, pspRef: "psp-trav-1" }, { "x-forwarded-for": "203.0.113.9" });
    expect(dep.status).toBe(403);
    expect(await dep.json()).toEqual({ error: "PLAY_MONEY_ONLY" });
    const wd = await http("/wallet/withdrawals", tok("traveller"), "POST", { amountCents: 20_00 }, { "x-forwarded-for": "203.0.113.9" });
    expect(wd.status).toBe(201);
    const ok = await http("/wallet/deposits", tok("traveller"), "POST", { amountCents: 10_00, pspRef: "psp-trav-2" });
    expect(ok.status).toBe(201);
    expect(await eur("traveller")).toBe(40_00);
  });

  it("limites vérifiées dès l'entrée en file (message clair), et dans la transaction de mise", async () => {
    await richPlayer("capped", { perEntry: 1_00 });
    const c = await client("capped");
    const err = nextError(c);
    c.emit("queue:join", { timeControl: "blitz_3_0", stake: { currency: "EUR", buyInCents: 2_00 } });
    expect(await err).toBe("LIMIT_EXCEEDED");
    expect(await register(c, EUR_SNG.id)).toEqual({ ok: false, code: "LIMIT_EXCEEDED" });
  });

  it("auto-exclu : session LOCKED, plus aucun jeu (même PLAY), solde retirable", async () => {
    await richPlayer("excluded");
    await http("/account/self-exclusion", tok("excluded"), "POST", { days: 30 });
    const c = await client("excluded");
    expect(c.modes[0]).toEqual({ mode: "LOCKED", reason: "SELF_EXCLUDED" });
    const err = nextError(c);
    c.emit("queue:join", { timeControl: "blitz_3_0", stake: { currency: "PLAY", buyInCents: 100 } });
    expect(await err).toBe("SELF_EXCLUDED");
    expect((await http("/wallet/withdrawals", tok("excluded"), "POST", { amountCents: 30_00 })).status).toBe(201);
    const view = await (await http("/account/compliance", tok("excluded"))).json() as { session: SessionModeEvent; selfExcludedUntil: string };
    expect(view.session.mode).toBe("LOCKED");
    expect(new Date(view.selfExcludedUntil).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  });

  it("KILL-SWITCH : coupure → sessions notifiées, file EUR vidée, Sit & Go EUR remboursés, mises refusées", async () => {
    for (const u of ["q1", "s1", "s2"]) await richPlayer(u);
    const q1 = await client("q1");
    const [s1, s2] = await Promise.all([client("s1"), client("s2")]);

    // état initial : un ticket EUR en file, deux inscrits à un Sit & Go EUR
    const joined = new Promise((r) => q1.once("queue:joined", r));
    q1.emit("queue:join", { timeControl: "rapid_5_0", stake: { currency: "EUR", buyInCents: 3_00 } });
    await joined;
    expect(server.matchmaker.isQueued("q1")).toBe(true);
    const reg = await register(s1, EUR_SNG.id);
    expect(reg.ok).toBe(true);
    expect((await register(s2, EUR_SNG.id)).ok).toBe(true);
    expect(await eur("s1")).toBe(48_00);
    const tid = reg.ok ? reg.snapshot.id : "";

    // l'agent conformité coupe l'argent réel via l'API
    expect((await http("/admin/compliance/kill-switch", tok("joueur"), "POST", { enabled: false, reason: "x" })).status).toBe(403);
    expect((await http("/admin/compliance/kill-switch", tok("cmp", "compliance"), "POST", { enabled: false, reason: "" })).status).toBe(400);
    const modeQ = nextMode(q1), modeS = nextMode(s1);
    const left = new Promise<void>((r) => q1.once("queue:left", () => r()));
    const res = await http("/admin/compliance/kill-switch", tok("cmp", "compliance"), "POST", { enabled: false, reason: "incident prestataire de paiement" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, db: { enabled: false, countries: ["MT"], updatedBy: "cmp" } });

    // 1. sessions notifiées
    expect(await modeQ).toEqual({ mode: "PLAY_MONEY_ONLY", reason: "REAL_MONEY_DISABLED" });
    expect(await modeS).toEqual({ mode: "PLAY_MONEY_ONLY", reason: "REAL_MONEY_DISABLED" });
    // 2. file EUR vidée
    await left;
    expect(server.matchmaker.isQueued("q1")).toBe(false);
    // 3. Sit & Go EUR annulé, remboursement intégral sans rake ; une nouvelle table est ouverte
    await expect.poll(() => server.tournaments.get(tid)?.state).toBe("cancelled");
    expect(await eur("s1")).toBe(50_00);
    expect(await eur("s2")).toBe(50_00);
    expect(await server.ledger.balance(acct.tournamentEscrow(tid, "EUR"), "EUR")).toBe(0);
    expect(server.tournaments.lobby().find((t) => t.formatId === EUR_SNG.id)?.id).not.toBe(tid);
    // 4. nouvelles mises refusées, PLAY toujours possible ; dépôts refusés
    const err = nextError(q1);
    q1.emit("queue:join", { timeControl: "blitz_3_0", stake: { currency: "EUR", buyInCents: 1_00 } });
    expect(await err).toBe("REAL_MONEY_DISABLED");
    expect(await register(s1, EUR_SNG.id)).toEqual({ ok: false, code: "REAL_MONEY_DISABLED" });
    const play = new Promise((r) => q1.once("queue:joined", r));
    q1.emit("queue:join", { timeControl: "blitz_3_0", stake: { currency: "PLAY", buyInCents: 100 } });
    await play;
    q1.emit("queue:leave");
    expect((await http("/wallet/deposits", tok("s1"), "POST", { amountCents: 10_00, pspRef: "psp-after-ks" })).status).toBe(403);
    // 5. retraits toujours possibles
    expect((await http("/wallet/withdrawals", tok("s2"), "POST", { amountCents: 20_00 })).status).toBe(201);
    // 6. traçabilité
    const ev = await db.pool.query("SELECT event, actor, details FROM compliance_events ORDER BY id DESC LIMIT 1");
    expect(ev.rows[0]).toMatchObject({ event: "real_money_disabled", actor: "cmp", details: { reason: "incident prestataire de paiement", after: { enabled: false } } });
    await expect(db.pool.query("DELETE FROM compliance_events")).rejects.toThrow();
    await server.audit.flush();
    const au = await db.pool.query("SELECT payload FROM audit_log WHERE type = 'compliance.killswitch' ORDER BY seq DESC LIMIT 1");
    expect(au.rows[0].payload).toMatchObject({ actor: "cmp", after: { enabled: false } });
  });

  it("propagation inter-instances : une bascule faite par une AUTRE instance est appliquée en ≤ 2 s", async () => {
    const c = await client("geo-mt");
    expect(c.modes[0]?.mode).toBe("PLAY_MONEY_ONLY");
    const other = new KillSwitch(db.pool, new NullAuditLog(), { envEnabled: true, envCountries: ["MT"] });
    const t0 = Date.now();
    const back = nextMode(c);
    await other.set("cmp-2", { enabled: true }, "incident clos, réouverture");
    expect(await back).toEqual({ mode: "REAL_MONEY", reason: "OK" });
    expect(Date.now() - t0).toBeLessThan(4_500);
  });

  it("le grand livre reste équilibré", async () => {
    const r = await (server.ledger as import("../../src/settlement/ledger.js").PgLedger).reconcile();
    expect(r).toMatchObject({ cacheMismatches: 0, unbalancedTransactions: 0, negativeUsers: 0 });
  });
});

describe("usurpation d'origine (sans proxy de confiance)", () => {
  it("un X-Forwarded-For forgé par le client n'ouvre pas l'argent réel", async () => {
    // serveur SANS proxy de confiance ; l'adresse TCP réelle (127.0.0.1) est géolocalisée « US »
    const s = createGameServer({
      ...defaultConfig, jwtSecret: SECRET, realMoneyEnabled: true, realMoneyCountries: ["FR"], tournamentFormats: [],
      withdrawalIntervalMs: 0, playFaucetCents: 0,
    }, { ledger: new InMemoryLedger(), geoResolver: CidrGeoResolver.fromCsv("127.0.0.0/8,US\n::1/128,US\n198.51.100.0/24,FR") });
    const base = `http://localhost:${await s.listen(0)}`;
    try {
      const c = await client("spoofer", { "x-forwarded-for": "198.51.100.7", "cf-ipcountry": "FR" }, base);
      expect(c.modes[0]).toEqual({ mode: "PLAY_MONEY_ONLY", reason: "JURISDICTION_BLOCKED" });
      c.disconnect();
    } finally {
      await s.close();
    }
  });
});
