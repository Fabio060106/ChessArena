import { Queue, type ConnectionOptions } from "bullmq";
import { ANALYSIS_QUEUE, type AnalysisRequest } from "@chessarena/shared";

/**
 * Producteur de la file `analysis` (consommée par services/analysis).
 * Contrat identique à services/analysis/src/queue.ts : identifiant de tâche = id de
 * partie (dédoublonnage), priorité EUR > PLAY, 5 tentatives, échecs conservés 30 jours.
 * La partie est durable dans Redis même si le service d'analyse est arrêté.
 */
export function makeAnalysisProducer(connection: ConnectionOptions, prefix: string) {
  const queue = new Queue(ANALYSIS_QUEUE, { connection, prefix });
  return {
    async submit(req: AnalysisRequest): Promise<void> {
      await queue.add("post_game", { gameId: req.gameId, request: req, reason: "post_game" }, {
        jobId: req.gameId,
        priority: req.currency === "EUR" ? 1 : 10,
        attempts: 5,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: { age: 24 * 3600, count: 50_000 },
        removeOnFail: { age: 30 * 24 * 3600 },
      });
    },
    close: () => queue.close(),
  };
}

export function redisConnection(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password || undefined,
    username: u.username || undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    tls: u.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}
