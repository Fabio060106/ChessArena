/**
 * Worker BullMQ — intégration sur Redis ET PostgreSQL réels.
 * Le moteur est remplacé par un analyseur scripté (profils de joueurs maîtrisés) ;
 * un dernier test fait tourner le vrai Stockfish 19 à travers tout le pipeline.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Queue, QueueEvents } from "bullmq";
import { Chess } from "chess.js";
import { VERDICT_QUEUE, type AnalysisRequest, type AnalysisResult, type Currency, type VerdictEvent } from "@chessarena/shared";
import { createTestDb, pgAvailable, type TestDb } from "@chessarena/testkit/testDb";
import { redisAvailable, testRedis } from "@chessarena/testkit/redis";
import { startAnalysisWorker, type AnalysisWorker } from "../src/worker.js";
import { makeQueues, redisConnection } from "../src/queue.js";
import type { AnalysisConfig } from "../src/config.js";
import { DEFAULT_RULES } from "../src/rules.js";
import { DEFAULT_METRICS } from "../src/metrics.js";
import { testEngineCommand } from "./engine.js";

const enabled = pgAvailable() && redisAvailable();

let db: TestDb;
let cfg: AnalysisConfig;
let queues: ReturnType<typeof makeQueues>;
const workers: AnalysisWorker[] = [];

/** profil de jeu scripté par joueur : ce que « verrait » le moteur */
const profiles = new Map<string, { acpl: number; match: number }>();
const analysedAt: Array<{ gameId: string; depth: number }> = [];
let failNext = 0;

async function fakeAnalyse(req: AnalysisRequest, depth: number): Promise<AnalysisResult> {
  if (failNext > 0) { failNext--; throw new Error("panne moteur simulée"); }
  analysedAt.push({ gameId: req.gameId, depth });
  const players = (["w", "b"] as const).map((color) => {
    const p = profiles.get(req.players[color].userId) ?? { acpl: 55, match: 0.5 };
    return {
      userId: req.players[color].userId, color, rating: req.players[color].rating, analysedMoves: 24,
      acpl: p.acpl, engineMatchRate: p.match, timeMeanMs: 4000, timeVariance: 4e6, timeCv: 0.5, focusLoss: 0,
    };
  });
  return { gameId: req.gameId, engine: "fake-sf", depth, players, moves: [], durationMs: 1 };
}

let minute = 0;
async function seedGame(w: string, b: string, currency: Currency = "PLAY", wRating = 1500, bRating = 1500, pgn = "1. e4 e5"): Promise<AnalysisRequest> {
  const id = randomUUID();
  await db.pool.query("INSERT INTO users (id, username) SELECT u, u FROM unnest($1::text[]) u ON CONFLICT DO NOTHING", [[w, b]]);
  const endedAt = new Date(Date.UTC(2026, 9, 1, 0, ++minute));
  await db.pool.query(
    `INSERT INTO games (id, white_id, black_id, time_control, currency, rated, result, termination, pgn, ended_at)
     VALUES ($1,$2,$3,'blitz_3_0',$4,true,'1-0','resignation',$5,$6)`, [id, w, b, currency, pgn, endedAt],
  );
  return {
    gameId: id, pgn, timeControl: "blitz_3_0", currency, moveTimesMs: [], focusLoss: { w: 0, b: 0 },
    players: { w: { userId: w, rating: wRating }, b: { userId: b, rating: bRating } }, endedAt: endedAt.toISOString(),
  };
}

async function startWorker(extra: Parameters<typeof startAnalysisWorker>[1] = {}) {
  const w = await startAnalysisWorker(cfg, { pool: db.pool, analyse: fakeAnalyse, concurrency: 1, ...extra });
  workers.push(w);
  return w;
}

/** attend que la file d'analyse soit vide et inactive */
async function drain(timeoutMs = 20_000) {
  const t0 = Date.now();
  for (;;) {
    const c = await queues.analysis.getJobCounts("waiting", "prioritized", "active", "delayed");
    if (Object.values(c).every((n) => n === 0)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`file non vidée : ${JSON.stringify(c)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function verdicts(): Promise<VerdictEvent[]> {
  const q = new Queue<VerdictEvent>(VERDICT_QUEUE, { connection: redisConnection(cfg.redisUrl), prefix: cfg.queuePrefix });
  const jobs = await q.getJobs(["waiting", "prioritized", "delayed", "active", "completed"]);
  await q.close();
  return jobs.map((j) => j.data);
}

describe.skipIf(!enabled)("worker BullMQ d'analyse", () => {
  beforeAll(async () => {
    db = await createTestDb();
    const r = testRedis();
    cfg = {
      port: 0, redisUrl: r.url, queuePrefix: r.prefix, databaseUrl: db.url, engineCommand: "", poolSize: 1, engineHashMb: 16,
      depthTriage: 12, depthFull: 18, historyLimit: 20, apiToken: "", runWorker: true,
      rules: { ...DEFAULT_RULES, confirmDepth: 18 }, metrics: DEFAULT_METRICS,
    };
    queues = makeQueues(redisConnection(r.url), r.prefix);
  });
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.close()));
    analysedAt.length = 0;
  });
  afterAll(async () => {
    await queues?.close();
    await db?.drop();
  });

  it("partie PLAY : triage en profondeur 12, analyse persistée, rejeu sans doublon", async () => {
    const req = await seedGame("p1", "p2");
    // double notification de fin de partie : un seul job (identifiant = gameId)
    await queues.enqueueAnalysis({ gameId: req.gameId, request: req, reason: "post_game" });
    await queues.enqueueAnalysis({ gameId: req.gameId, request: req, reason: "post_game" });
    await startWorker();
    await drain();
    expect(analysedAt).toEqual([{ gameId: req.gameId, depth: 12 }]);
    const stats = await db.pool.query("SELECT user_id, depth FROM anticheat_player_stats WHERE game_id = $1 ORDER BY user_id", [req.gameId]);
    expect(stats.rows).toEqual([{ user_id: "p1", depth: 12 }, { user_id: "p2", depth: 12 }]);
  });

  it("partie EUR : profondeur 18 et priorité sur les parties PLAY", async () => {
    const plays = await Promise.all([1, 2, 3].map(() => seedGame("q1", "q2")));
    const eur = await seedGame("q3", "q4", "EUR");
    for (const r of plays) await queues.enqueueAnalysis({ gameId: r.gameId, request: r, reason: "post_game" });
    await queues.enqueueAnalysis({ gameId: eur.gameId, request: eur, reason: "post_game" });
    await startWorker(); // démarré APRÈS la mise en file : l'ordre ne dépend que des priorités
    await drain();
    expect(analysedAt[0]).toEqual({ gameId: eur.gameId, depth: 18 });
    expect(analysedAt.slice(1).every((a) => a.depth === 12)).toBe(true);
  });

  it("joueur sous surveillance : ses parties PLAY passent en profondeur 18", async () => {
    await db.pool.query("INSERT INTO users (id, username, fairplay_watch) VALUES ('watched', 'watched', true) ON CONFLICT (id) DO UPDATE SET fairplay_watch = true");
    const req = await seedGame("watched", "r2");
    await queues.enqueueAnalysis({ gameId: req.gameId, request: req, reason: "post_game" });
    await startWorker();
    await drain();
    expect(analysedAt).toEqual([{ gameId: req.gameId, depth: 18 }]);
  });

  it("tricheur présumé : triage → CONFIRM → réanalyse profonde des 3 parties → verdict HOLD", async () => {
    profiles.set("sus", { acpl: 5, match: 0.9 });
    const games = [];
    for (let i = 0; i < 3; i++) games.push(await seedGame("sus", `victim${i}`, "PLAY", 1450));
    await startWorker();
    for (const r of games) await queues.enqueueAnalysis({ gameId: r.gameId, request: r, reason: "post_game" });
    await drain();

    // 3 analyses de triage, puis 3 confirmations en profondeur 18
    expect(analysedAt.filter((a) => a.depth === 12)).toHaveLength(3);
    expect(new Set(analysedAt.filter((a) => a.depth === 18).map((a) => a.gameId))).toEqual(new Set(games.map((g) => g.gameId)));
    const v = (await verdicts()).filter((x) => x.userId === "sus");
    expect(v.map((x) => x.level)).toContain("watch");   // pendant la confirmation
    const hold = v.find((x) => x.level === "hold")!;
    expect(hold).toMatchObject({ depth: 18, gameIds: games.map((g) => g.gameId) });
    expect(hold.reasons.join(" ")).toMatch(/ACPL < 10/);
    // les victimes ne sont pas inquiétées
    expect(v.every((x) => x.userId === "sus")).toBe(true);
    expect((await verdicts()).filter((x) => x.userId.startsWith("victim"))).toEqual([]);
  });

  it("joueur ≥ 2000 Elo au même profil : WATCH uniquement, aucun HOLD", async () => {
    profiles.set("master", { acpl: 5, match: 0.9 });
    await startWorker();
    for (let i = 0; i < 3; i++) {
      const r = await seedGame("master", `m-opp${i}`, "EUR", 2150);
      await queues.enqueueAnalysis({ gameId: r.gameId, request: r, reason: "post_game" });
    }
    await drain();
    const v = (await verdicts()).filter((x) => x.userId === "master");
    expect(v.length).toBeGreaterThan(0);
    expect(v.every((x) => x.level === "watch")).toBe(true);
  });

  it("panne transitoire du moteur : la tâche est retentée puis réussit", async () => {
    const req = await seedGame("t1", "t2");
    failNext = 1;
    await startWorker();
    const events = new QueueEvents("analysis", { connection: redisConnection(cfg.redisUrl), prefix: cfg.queuePrefix });
    const job = await queues.enqueueAnalysis({ gameId: req.gameId, request: req, reason: "post_game" });
    const done = await job.waitUntilFinished(events, 30_000);
    expect(done.analysed).toBe(true);
    const j = (await queues.analysis.getJob(job.id!))!;
    expect(j.stacktrace).toHaveLength(1);          // un échec enregistré…
    expect(await j.isCompleted()).toBe(true);      // …puis le succès
    await events.close();
  });

  it("erreur définitive (PGN invalide) : échec immédiat, sans nouvelle tentative", async () => {
    const req = await seedGame("u1", "u2", "PLAY", 1500, 1500, "1. e4 e5 2. Ke9");
    const w = await startAnalysisWorker(cfg, { pool: db.pool, concurrency: 1, analyse: async (r) => {
      new Chess().loadPgn(r.pgn); // lève « Invalid move »
      return fakeAnalyse(r, 12);
    } });
    workers.push(w);
    const job = await queues.enqueueAnalysis({ gameId: req.gameId, request: req, reason: "post_game" });
    for (let i = 0; i < 100 && !(await job.isFailed()); i++) await new Promise((r) => setTimeout(r, 50));
    const j = (await queues.analysis.getJob(job.id!))!;
    expect(await j.isFailed()).toBe(true);
    expect(j.attemptsMade).toBe(1);
  });

  it("worker tué (SIGKILL) en pleine analyse : la tâche est reprise par un autre worker, sans perte ni doublon", async () => {
    const req = await seedGame("k1", "k2");
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./stall-child.ts", import.meta.url)), cfg.redisUrl, cfg.queuePrefix, db.url], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve) => child.stdout.on("data", (d: Buffer) => { if (d.toString().includes("ACTIVE")) resolve(); }) && queues.enqueueAnalysis({ gameId: req.gameId, request: req, reason: "post_game" }));
    expect(await queues.analysis.getActiveCount()).toBe(1);
    child.kill("SIGKILL");
    await new Promise((r) => child.on("exit", r));
    await startWorker({ lockDuration: 1_000, stalledInterval: 500 });
    await drain(30_000);
    expect(analysedAt.map((a) => a.gameId)).toEqual([req.gameId]);
    expect((await db.pool.query("SELECT count(*)::int n FROM anticheat_analyses WHERE game_id = $1", [req.gameId])).rows[0].n).toBe(1);
  });

  const engine = testEngineCommand();
  it.skipIf(!engine)("de bout en bout avec Stockfish 19 réel : PGN → pool UCI → base", async () => {
    const pgn = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 11. Nbd2 Bb7 12. Bc2 Re8 13. Nf1 Bf8 14. Ng3 g6 15. a4 c5 16. d5 c4 17. Bg5 h6 18. Be3 Nc5 19. Qd2 h5 20. Bg5 Be7 21. Bh6 Nfd7 22. Nf5 *";
    const req = await seedGame("sf-w", "sf-b", "PLAY", 1600, 1600, pgn);
    const real = await startAnalysisWorker({ ...cfg, engineCommand: engine!, poolSize: 2, depthTriage: 6 }, { pool: db.pool });
    workers.push(real);
    expect(real.pool!.name).toMatch(/Stockfish 19/);
    await queues.enqueueAnalysis({ gameId: req.gameId, request: { ...req, moveTimesMs: Array.from({ length: 43 }, (_, i) => 500 + i * 37) }, reason: "post_game" });
    await drain(120_000);
    const a = (await real.store.getAnalysis(req.gameId))[0]!;
    expect(a.engine).toMatch(/Stockfish 19/);
    const moves = a.moves as Array<{ included: boolean; excludedBy: string | null; bestUci: string }>;
    expect(moves).toHaveLength(43);
    expect(moves.slice(0, 16).every((m) => m.excludedBy === "opening")).toBe(true);
    expect(moves.filter((m) => m.included).length).toBeGreaterThan(20);
    const stats = a.stats as Array<{ acpl: string; analysed_moves: number }>;
    expect(stats).toHaveLength(2);
    for (const s of stats) expect(Number(s.acpl)).toBeGreaterThanOrEqual(0);
  }, 180_000);
});
