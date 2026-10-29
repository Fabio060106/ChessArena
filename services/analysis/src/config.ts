import { availableParallelism } from "node:os";
import { DEFAULT_RULES, type RuleConfig } from "./rules.js";
import { DEFAULT_METRICS, type MetricsConfig } from "./metrics.js";

export interface AnalysisConfig {
  port: number;
  redisUrl: string;
  /** préfixe des clés BullMQ (isolation des environnements / des tests) */
  queuePrefix: string;
  databaseUrl: string;
  /** commande du moteur ("stockfish" ou "node …/stockfish-19-lite-single.js") */
  engineCommand: string;
  /** processus moteur (1 par cœur par défaut) = concurrence du worker */
  poolSize: number;
  engineHashMb: number;
  depthTriage: number;
  /** 18 à 20 : parties EUR, joueurs sous surveillance, confirmations */
  depthFull: number;
  historyLimit: number;
  /** jeton partagé exigé sur POST /analyze (vide = désactivé, réseau interne uniquement) */
  apiToken: string;
  runWorker: boolean;
  rules: RuleConfig;
  metrics: MetricsConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AnalysisConfig {
  const depthFull = Number(env.DEPTH_FULL ?? 18);
  if (depthFull < 18 || depthFull > 20) throw new Error("DEPTH_FULL doit être compris entre 18 et 20");
  const cfg: AnalysisConfig = {
    port: Number(env.PORT ?? 4100),
    redisUrl: env.REDIS_URL ?? "redis://127.0.0.1:6379",
    queuePrefix: env.QUEUE_PREFIX ?? "arena",
    databaseUrl: env.DATABASE_URL ?? "",
    engineCommand: env.STOCKFISH_CMD ?? env.STOCKFISH_PATH ?? "stockfish",
    poolSize: Number(env.ENGINE_POOL ?? availableParallelism()),
    engineHashMb: Number(env.ENGINE_HASH_MB ?? 64),
    depthTriage: Number(env.DEPTH_TRIAGE ?? 12),
    depthFull,
    historyLimit: 20,
    apiToken: env.ANALYSIS_API_TOKEN ?? "",
    runWorker: env.RUN_WORKER !== "0",
    rules: { ...DEFAULT_RULES, confirmDepth: depthFull },
    metrics: DEFAULT_METRICS,
  };
  if (!cfg.databaseUrl) throw new Error("DATABASE_URL requis");
  return cfg;
}
