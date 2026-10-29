/**
 * Bout en bout sur PostgreSQL réel : vrais sockets, vrais JWT, vrai schéma.
 *   1. duel PLAY : mises bloquées → partie → règlement → partie + Elo + audit en base ;
 *   2. Sit & Go à 4 : inscriptions → tableau → finale → 65/35 − rake → tout persisté ;
 *   3. crash serveur avec mises bloquées → redémarrage → remboursement automatique.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { io as connect, type Socket } from "socket.io-client";
import type { ClientToServerEvents, GameOverEvent, GameStartEvent, ServerToClientEvents, SngAck, SngSnapshot } from "@chessarena/shared";
import { createGameServer, type GameServer } from "../../src/app.js";
import { defaultConfig, type GameServerConfig } from "../../src/config.js";
import { PgLedger, acct } from "../../src/settlement/ledger.js";
import { verifyAuditTable } from "../../src/audit/auditLog.js";
import { createTestDb, pgAvailable, type TestDb } from "@chessarena/testkit/testDb";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const SECRET = "e2e-pg-secret-e2e-pg-secret-e2e-pg";

let db: TestDb;
const clients: Client[] = [];
const cfg = (): GameServerConfig => ({
  ...defaultConfig,
  jwtSecret: SECRET, matchmakerTickMs: 25, disconnectGraceMs: 300, lagProbeIntervalMs: 1_000, analysisEnabled: false,
  tournamentFormats: [{ id: "sng4", size: 4, timeControl: "blitz_3_0", currency: "PLAY", buyInCents: 500 }],
});

async function start(): Promise<{ server: GameServer; url: string }> {
  const server = createGameServer(cfg(), { pool: db.pool });
  const port = await server.listen(0);
  return { server, url: `http://localhost:${port}` };
}

function client(url: string, sub: string): Promise<Client> {
  const c: Client = connect(url, {
    transports: ["websocket"], reconnection: false, forceNew: true,
    auth: { token: jwt.sign({ sub }, SECRET, { expiresIn: "5m" }) },
  });
  clients.push(c);
  return new Promise((res, rej) => { c.on("connect", () => res(c)); c.on("connect_error", rej); });
}

function once<T>(c: Client, ev: keyof ServerToClientEvents, pred: (p: T) => boolean = () => true, ms = 8_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${String(ev)}`)), ms);
    const h = (p: T) => { if (pred(p)) { clearTimeout(t); (c as unknown as { off: (e: string, f: unknown) => void }).off(ev, h); resolve(p); } };
    (c as unknown as { on: (e: string, f: unknown) => void }).on(ev, h);
  });
}

const balance = (u: string) => new PgLedger(db.pool).balance(acct.user(u, "PLAY"), "PLAY");

describe.skipIf(!pgAvailable())("bout en bout — PostgreSQL", () => {
  beforeAll(async () => { db = await createTestDb(); });
  afterAll(async () => {
    clients.forEach((c) => c.disconnect());
    await db?.drop();
  });

  it("duel PLAY : règlement, partie, Elo et audit persistés", async () => {
    const { server, url } = await start();
    const [a, b] = await Promise.all([client(url, "ann"), client(url, "ben")]);
    await new Promise((r) => setTimeout(r, 100)); // faucet de bienvenue
    const startA = once<GameStartEvent>(a, "game:start");
    for (const c of [a, b]) c.emit("queue:join", { timeControl: "blitz_3_0", stake: { currency: "PLAY", buyInCents: 200 } });
    const g = await startA;
    const [w, bl] = g.white.userId === "ann" ? [a, b] : [b, a];
    const over = once<GameOverEvent>(w, "game:over");
    for (const [c, uci, ply] of [[w, "f2f3", 0], [bl, "e7e5", 1], [w, "g2g4", 2], [bl, "d8h4", 3]] as const) {
      await new Promise((r) => c.emit("game:move", { gameId: g.gameId, uci, ply }, r));
    }
    const o = await over;
    expect(o).toMatchObject({ result: "0-1", termination: "checkmate", rakeCents: 40 });
    expect(o.ratingChanges![g.black.userId]).toEqual({ before: 1500, after: 1520 });

    expect(await balance(g.black.userId)).toBe(10_000 - 200 + 360);
    const row = (await db.pool.query("SELECT * FROM games WHERE id = $1", [g.gameId])).rows[0];
    expect(row).toMatchObject({ result: "0-1", rated: true, black_rating_after: 1520, buy_in_cents: "200" });
    expect(row.pgn).toMatch(/Qh4#/);

    // l'Elo persisté sert au prochain appariement (relu à chaque queue:join)
    expect((await server.repo.getRatings(g.black.userId)).blitz_3_0.rating).toBe(1520);
    await server.close();
    const v = await verifyAuditTable(db.pool);
    expect(v.ok).toBe(true);
    const types = (await db.pool.query("SELECT type, count(*)::int n FROM audit_log GROUP BY type")).rows;
    expect(Object.fromEntries(types.map((t) => [t.type, t.n]))).toMatchObject({ "game.move": 4, "game.end": 1 });
  });

  it("Sit & Go à 4 : inscriptions, tableau KO, finale, 65/35 après rake, tout en base", async () => {
    const { server, url } = await start();
    const names = ["s1", "s2", "s3", "s4"];
    const cs = await Promise.all(names.map((n) => client(url, n)));
    await new Promise((r) => setTimeout(r, 150));
    // chaque joueur qui reçoit les Noirs abandonne d'emblée (annulation imputée → défaite)
    cs.forEach((c, i) => c.on("game:start", (g) => {
      if (g.black.userId === names[i]) setTimeout(() => c.emit("game:resign", { gameId: g.gameId }), 20);
    }));
    const finished = once<SngSnapshot>(cs[0]!, "sng:update", (s) => s.status === "finished", 15_000);
    for (const c of cs) {
      const ack = await new Promise<SngAck>((r) => c.emit("sng:register", { formatId: "sng4" }, r));
      expect(ack.ok).toBe(true);
    }
    const s = await finished;
    const winner = s.players.find((p) => p.finalRank === 1)!;
    const finalist = s.players.find((p) => p.finalRank === 2)!;
    expect(winner.payoutCents).toBe(1170);
    expect(finalist.payoutCents).toBe(630);
    expect(s.rakeCents).toBe(200);
    expect(await balance(winner.userId)).toBe(10_000 - 500 + 1170);
    for (const p of s.players.filter((x) => x.finalRank === 3)) expect(await balance(p.userId)).toBe(10_000 - 500);

    await server.close();
    const t = (await db.pool.query("SELECT status, ranking FROM tournaments WHERE id = $1", [s.id])).rows[0];
    expect(t).toMatchObject({ status: "finished" });
    expect(t.ranking.slice(0, 2)).toEqual([winner.userId, finalist.userId]);
    const games = (await db.pool.query("SELECT count(*)::int n FROM games WHERE tournament_id = $1", [s.id])).rows[0].n;
    expect(games).toBe(3);
    const matches = (await db.pool.query("SELECT count(*)::int n FROM tournament_matches WHERE tournament_id = $1 AND status = 'done'", [s.id])).rows[0].n;
    expect(matches).toBe(3);
    const rec = await new PgLedger(db.pool).reconcile();
    expect(rec).toMatchObject({ totals: { PLAY: 0 }, cacheMismatches: 0, unbalancedTransactions: 0, negativeUsers: 0 });
    expect((await verifyAuditTable(db.pool)).ok).toBe(true);
  });

  it("crash avec mises bloquées (duel + Sit & Go incomplet) → au redémarrage, tout est remboursé", async () => {
    const first = await start();
    const [x, y, z] = (await Promise.all(["cx", "cy", "cz"].map((n) => client(first.url, n)))) as [Client, Client, Client];
    await new Promise((r) => setTimeout(r, 150));
    const started = once<GameStartEvent>(x, "game:start");
    for (const c of [x, y]) c.emit("queue:join", { timeControl: "rapid_5_0", stake: { currency: "PLAY", buyInCents: 300 } });
    await started;
    const ack = await new Promise<SngAck>((r) => z.emit("sng:register", { formatId: "sng4" }, r));
    expect(ack.ok).toBe(true);
    expect(await balance("cx")).toBe(9_700);
    expect(await balance("cz")).toBe(9_500);

    // « crash » : le process s'arrête sans régler ni annuler quoi que ce soit
    first.server.games.disposeAll();
    first.server.io.disconnectSockets(true);
    await new Promise<void>((r) => first.server.io.close(() => r()));
    await first.server.audit.close();

    const second = await start(); // listen() exécute la récupération
    for (const u of ["cx", "cy", "cz"]) expect(await balance(u)).toBe(10_000);
    const t = (await db.pool.query("SELECT status, cancel_reason FROM tournaments WHERE id = $1", [(ack as { snapshot: SngSnapshot }).snapshot.id])).rows[0];
    expect(t).toEqual({ status: "cancelled", cancel_reason: "server_restart" });
    const rec = await new PgLedger(db.pool).reconcile();
    expect(rec).toMatchObject({ totals: { PLAY: 0 }, cacheMismatches: 0, unbalancedTransactions: 0 });
    expect(await new PgLedger(db.pool).openEscrows()).toEqual([]);
    await second.server.close();
  });
});
