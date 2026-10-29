/**
 * Chaîne complète, trois composants réels réunis :
 *   game-server (sockets, PostgreSQL) ──BullMQ──▶ worker d'analyse ──BullMQ──▶ FairPlayEnforcer
 *
 * Un joueur dont le moteur (simulé) voit un ACPL de 4 et 92 % de coïncidence joue
 * 3 parties : triage → confirmation en profondeur → HOLD → retrait retenu.
 * Pendant ce temps il continue à jouer normalement (aucun signal visible).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { io as connect, type Socket } from "socket.io-client";
import type { AnalysisRequest, AnalysisResult, ClientToServerEvents, GameOverEvent, GameStartEvent, ServerToClientEvents } from "@chessarena/shared";
import { createTestDb, pgAvailable, type TestDb } from "@chessarena/testkit/testDb";
import { redisAvailable, testRedis } from "@chessarena/testkit/redis";
import { createGameServer, type GameServer } from "../../src/app.js";
import { defaultConfig } from "../../src/config.js";
import { acct } from "../../src/settlement/ledger.js";
import { seedEur } from "../helpers.js";
import { startAnalysisWorker, type AnalysisWorker } from "../../../../services/analysis/src/worker.js";
import { DEFAULT_RULES } from "../../../../services/analysis/src/rules.js";
import { DEFAULT_METRICS } from "../../../../services/analysis/src/metrics.js";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const SECRET = "fairplay-e2e-secret-fairplay-e2e-secret";
const LINE = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7", "f1e1", "b7b5", "a4b3", "d7d6", "c2c3", "e8g8", "h2h3", "c6b8", "d2d4", "b8d7", "b1d2", "c8b7"];

let db: TestDb;
let server: GameServer;
let worker: AnalysisWorker;
let url = "";
const analysed: Array<{ gameId: string; depth: number }> = [];
const clients: Client[] = [];

/** moteur simulé : « voit » un tricheur dans `ringer`, des humains ailleurs */
async function fakeEngine(req: AnalysisRequest, depth: number): Promise<AnalysisResult> {
  analysed.push({ gameId: req.gameId, depth });
  const players = (["w", "b"] as const).map((color) => {
    const cheat = req.players[color].userId === "ringer";
    return {
      userId: req.players[color].userId, color, rating: req.players[color].rating, analysedMoves: 22,
      acpl: cheat ? 4 : 52, engineMatchRate: cheat ? 0.92 : 0.48, timeMeanMs: 3000, timeVariance: 4e6, timeCv: 0.6, focusLoss: 0,
    };
  });
  return { gameId: req.gameId, engine: "Stockfish 19 (simulé)", depth, players, moves: [], durationMs: 5 };
}

function client(sub: string): Promise<Client> {
  const c: Client = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false, auth: { token: jwt.sign({ sub }, SECRET) } });
  clients.push(c);
  return new Promise((res, rej) => { c.on("connect", () => res(c)); c.on("connect_error", rej); });
}

async function playGame(a: Client, b: Client): Promise<GameOverEvent> {
  const start = new Promise<GameStartEvent>((r) => a.once("game:start", r));
  for (const c of [a, b]) c.emit("queue:join", { timeControl: "blitz_3_0", stake: { currency: "PLAY", buyInCents: 100 } });
  const g = await start;
  const white = g.white.userId === "ringer" ? a : b; // `a` est toujours le joueur « ringer »
  const black = white === a ? b : a;
  const over = new Promise<GameOverEvent>((r) => a.once("game:over", r));
  for (let ply = 0; ply < LINE.length; ply++) {
    const c = ply % 2 === 0 ? white : black;
    const ack = await new Promise<{ ok: boolean }>((r) => c.emit("game:move", { gameId: g.gameId, uci: LINE[ply]!, ply }, r));
    expect(ack.ok).toBe(true);
  }
  black.emit("game:resign", { gameId: g.gameId });
  return over;
}

const enabled = pgAvailable() && redisAvailable();

describe.skipIf(!enabled)("anti-triche de bout en bout (game-server ⇄ BullMQ ⇄ analyse)", () => {
  beforeAll(async () => {
    db = await createTestDb();
    const r = testRedis();
    server = createGameServer({
      ...defaultConfig, jwtSecret: SECRET, redisUrl: r.url, queuePrefix: r.prefix, matchmakerTickMs: 20,
      withdrawalIntervalMs: 0, tournamentFormats: [],
      rateLimit: { burst: 1_000, perSecond: 1_000 }, // le test joue bien plus vite qu'un humain
    }, { pool: db.pool });
    url = `http://localhost:${await server.listen(0)}`;
    worker = await startAnalysisWorker({
      port: 0, redisUrl: r.url, queuePrefix: r.prefix, databaseUrl: db.url, engineCommand: "", poolSize: 2, engineHashMb: 16,
      depthTriage: 12, depthFull: 18, historyLimit: 20, apiToken: "", runWorker: true,
      rules: { ...DEFAULT_RULES, confirmDepth: 18 }, metrics: DEFAULT_METRICS,
    }, { pool: db.pool, analyse: fakeEngine, concurrency: 2 });
  });
  afterAll(async () => {
    clients.forEach((c) => c.disconnect());
    await worker?.close();
    await server?.close();
    await db?.drop();
  });

  it("3 parties → triage → confirmation profonde → WITHDRAWAL_HOLD ; le jeu continue ; le retrait est retenu", async () => {
    const ringer = await client("ringer");
    const opponents = await Promise.all(["h1", "h2", "h3"].map(client));
    await new Promise((r) => setTimeout(r, 200)); // dotation PLAY de bienvenue

    // dépôt EUR (sandbox) pour tester le retrait ensuite
    await db.pool.query("UPDATE users SET kyc = 'verified' WHERE id = 'ringer'");
    await seedEur(db.pool, server.ledger, "ringer", 100_00);

    for (const opp of opponents) await playGame(ringer, opp);

    // attendre l'application du verdict par le game-server
    for (let i = 0; i < 300; i++) {
      const s = (await db.pool.query("SELECT state FROM users WHERE id = 'ringer'")).rows[0].state;
      if (s === "withdrawal_hold") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const st = (await db.pool.query("SELECT state, fairplay_watch FROM users WHERE id = 'ringer'")).rows[0];
    expect(st).toEqual({ state: "withdrawal_hold", fairplay_watch: true });

    // les 3 parties : triage (12) puis confirmation (18)
    const games = (await db.pool.query("SELECT id FROM games ORDER BY ended_at")).rows.map((x) => x.id);
    for (const id of games) {
      expect(analysed.some((a) => a.gameId === id && a.depth === 12)).toBe(true);
      expect(analysed.some((a) => a.gameId === id && a.depth === 18)).toBe(true);
    }
    const kase = (await db.pool.query("SELECT level, status FROM anticheat_cases WHERE user_id = 'ringer'")).rows;
    expect(kase).toEqual([{ level: "hold", status: "open" }]);
    // les adversaires honnêtes : aucun dossier
    expect((await db.pool.query("SELECT count(*)::int n FROM anticheat_cases WHERE user_id <> 'ringer'")).rows[0].n).toBe(0);

    // DISCRÉTION : le joueur peut toujours se connecter et rejoindre une file
    const again = await client("ringer");
    const joined = new Promise((r) => again.once("queue:joined", r));
    const errors: string[] = [];
    again.on("error", (e) => errors.push(e.code));
    again.emit("queue:join", { timeControl: "rapid_5_0", stake: { currency: "PLAY", buyInCents: 0 } });
    await joined;
    expect(errors).toEqual([]);

    // … mais son retrait ne sortira pas
    const wd = await server.withdrawals!.request("ringer", 50_00);
    expect(wd.status).toBe("processing");
    expect(await server.withdrawals!.processOne(wd.id)).toBe("held");
    expect((await server.withdrawals!.list("ringer"))[0]!.status).toBe("processing");
    expect(await server.ledger.balance(acct.pspOut(), "EUR")).toBe(0);
  }, 60_000);
});
