import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";
import { ANALYSIS_QUEUE, VERDICT_QUEUE, type AnalysisRequest, type VerdictEvent } from "@chessarena/shared";

/**
 * Contrat des files BullMQ.
 *
 *   analysis           game-server → worker   une tâche par partie (+ réanalyses de confirmation)
 *   fairplay-verdicts  worker → game-server   WATCH / HOLD à appliquer
 *
 * Idempotence : identifiants de tâche déterministes. Une partie terminée deux fois
 * (rejeu, double notification) ne produit qu'une tâche ; un verdict identique aussi.
 * NB : BullMQ interdit « : » dans les identifiants personnalisés.
 */
export interface AnalysisJobData {
  gameId: string;
  /** absent pour une confirmation : rechargée depuis la base */
  request?: AnalysisRequest;
  /** profondeur imposée (confirmation) ; sinon triage automatique */
  depth?: number;
  reason: "post_game" | "confirm" | "manual";
}

export const PRIORITY = { EUR: 1, CONFIRM: 2, MANUAL: 3, PLAY: 10 } as const;

const BASE: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2_000 },
  // file des échecs définitifs conservée 30 jours : c'est la « dead letter queue »
  removeOnComplete: { age: 24 * 3600, count: 50_000 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

export const analysisJobId = (gameId: string, depth?: number) => (depth ? `${gameId}-d${depth}` : gameId);

export function analysisJobOptions(data: AnalysisJobData): JobsOptions {
  const priority = data.reason === "confirm" ? PRIORITY.CONFIRM
    : data.reason === "manual" ? PRIORITY.MANUAL
    : data.request?.currency === "EUR" ? PRIORITY.EUR : PRIORITY.PLAY;
  return { ...BASE, jobId: analysisJobId(data.gameId, data.depth), priority };
}

export function verdictJobId(v: VerdictEvent): string {
  return `${v.userId}-${v.level}-${v.gameIds.at(-1) ?? "none"}-d${v.depth}`;
}

export const VERDICT_JOB_OPTIONS: JobsOptions = { ...BASE, attempts: 10 };

export function makeQueues(connection: ConnectionOptions, prefix: string) {
  const analysis = new Queue<AnalysisJobData>(ANALYSIS_QUEUE, { connection, prefix });
  const verdicts = new Queue<VerdictEvent>(VERDICT_QUEUE, { connection, prefix });
  return {
    analysis,
    verdicts,
    enqueueAnalysis: (data: AnalysisJobData) => analysis.add(data.reason, data, analysisJobOptions(data)),
    emitVerdict: (v: VerdictEvent) => verdicts.add(v.level, v, { ...VERDICT_JOB_OPTIONS, jobId: verdictJobId(v) }),
    close: async () => { await Promise.all([analysis.close(), verdicts.close()]); },
  };
}

/** `redis://host:port/db` → options de connexion BullMQ (ioredis). */
export function redisConnection(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password || undefined,
    username: u.username || undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    tls: u.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null, // exigé par BullMQ pour les workers
  };
}
