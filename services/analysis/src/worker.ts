import { fileURLToPath } from "node:url";
import pg from "pg";
import { UnrecoverableError, Worker, type Job } from "bullmq";
import { ANALYSIS_QUEUE, type AnalysisRequest, type AnalysisResult } from "@chessarena/shared";
import { loadConfig, type AnalysisConfig } from "./config.js";
import { EnginePool } from "./uci.js";
import { analyseGame } from "./metrics.js";
import { PgAnalysisStore, type AnalysisStore } from "./store.js";
import { makeQueues, redisConnection, type AnalysisJobData } from "./queue.js";
import { PermanentJobError, processAnalysisJob, type JobOutcome } from "./pipeline.js";

/**
 * Worker BullMQ d'analyse.
 *
 * Concurrence = taille du pool de moteurs (1 processus Stockfish mono-thread par cœur) :
 * chaque tâche active détient exactement un moteur. Les priorités BullMQ font passer
 * les parties EUR et les confirmations avant le volume de parties PLAY.
 */
export interface AnalysisWorker {
  worker: Worker<AnalysisJobData, JobOutcome>;
  pool: EnginePool | null;
  store: AnalysisStore;
  queues: ReturnType<typeof makeQueues>;
  close(): Promise<void>;
}

export interface WorkerOverrides {
  pool?: pg.Pool;
  /** remplace le moteur (tests) */
  analyse?: (req: AnalysisRequest, depth: number) => Promise<AnalysisResult>;
  concurrency?: number;
  /** tests : détection rapide des tâches abandonnées par un worker mort */
  lockDuration?: number;
  stalledInterval?: number;
}

export async function startAnalysisWorker(cfg: AnalysisConfig, o: WorkerOverrides = {}): Promise<AnalysisWorker> {
  const connection = redisConnection(cfg.redisUrl);
  const db = o.pool ?? new pg.Pool({ connectionString: cfg.databaseUrl, max: Math.max(4, cfg.poolSize + 2) });
  const store = new PgAnalysisStore(db);
  const queues = makeQueues(connection, cfg.queuePrefix);

  let enginePool: EnginePool | null = null;
  let analyse = o.analyse;
  if (!analyse) {
    enginePool = new EnginePool({ command: cfg.engineCommand, size: cfg.poolSize, hashMb: cfg.engineHashMb, threads: 1 });
    await enginePool.init();
    const p = enginePool;
    analyse = async (req, depth) => {
      const t0 = performance.now();
      const r = await p.use(async (engine) => {
        await engine.newGame();
        return analyseGame(req, (fen) => engine.evaluate(fen, depth), cfg.metrics);
      });
      return { gameId: req.gameId, engine: p.name, depth, players: r.players, moves: r.moves, durationMs: performance.now() - t0 };
    };
  }
  const run = analyse;

  const worker = new Worker<AnalysisJobData, JobOutcome>(
    ANALYSIS_QUEUE,
    async (job: Job<AnalysisJobData>) => {
      try {
        return await processAnalysisJob(job.data, {
          store,
          analyse: run,
          enqueueConfirm: async (gameId, depth) => { await queues.enqueueAnalysis({ gameId, depth, reason: "confirm" }); },
          emitVerdict: async (v) => { await queues.emitVerdict(v); },
          rules: cfg.rules,
          depthTriage: cfg.depthTriage,
          depthFull: cfg.depthFull,
          historyLimit: cfg.historyLimit,
        });
      } catch (e) {
        // erreur définitive (données absentes, PGN invalide) : inutile de réessayer
        if (e instanceof PermanentJobError) {
          throw new UnrecoverableError((e as Error).message);
        }
        throw e;
      }
    },
    {
      connection,
      prefix: cfg.queuePrefix,
      concurrency: o.concurrency ?? enginePool?.size ?? cfg.poolSize,
      lockDuration: o.lockDuration ?? 120_000, // une analyse profonde peut durer ; le verrou est renouvelé automatiquement
      stalledInterval: o.stalledInterval ?? 30_000,
      maxStalledCount: 2,
    },
  );
  worker.on("failed", (job, err) => {
    const final = job && (err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1));
    console.error(`[worker] ${job?.id} ${final ? "ÉCHEC DÉFINITIF" : `échec (essai ${job?.attemptsMade})`} : ${err.message}`);
  });

  return {
    worker, pool: enginePool, store, queues,
    async close() {
      await worker.close();
      await queues.close();
      enginePool?.close();
      if (!o.pool) await db.end();
    },
  };
}

// CLI : `npm run worker` — worker seul, sans API HTTP (déploiement à l'échelle)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cfg = loadConfig();
  const w = await startAnalysisWorker(cfg);
  console.log(`[worker] ${w.pool?.name} × ${w.pool?.size} — profondeurs ${cfg.depthTriage}/${cfg.depthFull}`);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => { await w.close(); process.exit(0); });
  }
}
