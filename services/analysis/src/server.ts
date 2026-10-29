import { createServer, type IncomingMessage, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { AnalysisRequest } from "@chessarena/shared";
import { loadConfig, type AnalysisConfig } from "./config.js";
import { makeQueues, redisConnection } from "./queue.js";
import { PgAnalysisStore } from "./store.js";
import { startAnalysisWorker, type AnalysisWorker } from "./worker.js";

/**
 * API HTTP du service d'analyse.
 *   GET  /health              état + taille du pool
 *   GET  /metrics             compteurs de la file (en attente, actives, échecs…)
 *   POST /analyze             mise en file d'une partie (compatibilité ; le game-server
 *                             écrit directement dans BullMQ quand REDIS_URL est défini)
 *   GET  /reports/:gameId     analyses enregistrées d'une partie
 *
 * Par défaut le worker tourne dans le même processus (RUN_WORKER=0 pour l'API seule).
 */
function readJson(req: IncomingMessage, limit = 512 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error("payload trop gros")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(e); } });
  });
}

function isRequest(b: unknown): b is AnalysisRequest {
  const r = b as AnalysisRequest;
  return !!r && typeof r.gameId === "string" && typeof r.pgn === "string" && !!r.players?.w?.userId && !!r.players?.b?.userId
    && Array.isArray(r.moveTimesMs) && (r.currency === "PLAY" || r.currency === "EUR");
}

export async function startServer(cfg: AnalysisConfig): Promise<{ server: Server; worker: AnalysisWorker | null; close(): Promise<void> }> {
  const db = new pg.Pool({ connectionString: cfg.databaseUrl, max: cfg.poolSize + 4 });
  const store = new PgAnalysisStore(db);
  const queues = makeQueues(redisConnection(cfg.redisUrl), cfg.queuePrefix);
  const worker = cfg.runWorker ? await startAnalysisWorker(cfg, { pool: db }) : null;

  const server = createServer(async (req, res) => {
    const json = (code: number, body: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
    try {
      if (req.method === "GET" && req.url === "/health") {
        return json(200, { ok: true, engine: worker?.pool?.name ?? null, pool: worker?.pool?.size ?? 0, replaced: worker?.pool?.replaced ?? 0 });
      }
      if (req.method === "GET" && req.url === "/metrics") {
        const counts = await queues.analysis.getJobCounts("waiting", "prioritized", "active", "delayed", "completed", "failed");
        return json(200, { queue: counts, verdicts: await queues.verdicts.getJobCounts("waiting", "active", "failed") });
      }
      if (req.method === "POST" && req.url === "/analyze") {
        if (cfg.apiToken && req.headers.authorization !== `Bearer ${cfg.apiToken}`) return json(401, { error: "unauthorized" });
        const body = await readJson(req);
        if (!isRequest(body)) return json(400, { error: "requête invalide" });
        const job = await queues.enqueueAnalysis({ gameId: body.gameId, request: body, reason: "post_game" });
        return json(202, { accepted: body.gameId, jobId: job.id });
      }
      const m = req.url?.match(/^\/reports\/([0-9a-f-]{36})$/);
      if (req.method === "GET" && m) {
        const a = await store.getAnalysis(m[1]!);
        return a.length ? json(200, a) : json(404, { error: "inconnu ou en cours" });
      }
      json(404, { error: "not found" });
    } catch (e) {
      json(500, { error: (e as Error).message });
    }
  });

  await new Promise<void>((r) => server.listen(cfg.port, r));
  return {
    server, worker,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await worker?.close();
      await queues.close();
      await db.end();
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cfg = loadConfig();
  const s = await startServer(cfg);
  console.log(`[analysis] :${cfg.port} — worker ${s.worker ? `${s.worker.pool?.name} × ${s.worker.pool?.size}` : "désactivé"} — profondeurs ${cfg.depthTriage}/${cfg.depthFull}`);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => { await s.close(); process.exit(0); });
  }
}
