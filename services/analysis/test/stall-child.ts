/**
 * Worker « victime » : prend une tâche puis reste bloqué dedans jusqu'à être tué
 * (SIGKILL). Sert à prouver qu'une tâche orpheline est reprise par un autre worker.
 *   node --import tsx stall-child.ts <redisUrl> <prefix> <databaseUrl>
 */
import { startAnalysisWorker } from "../src/worker.js";
import { DEFAULT_RULES } from "../src/rules.js";
import { DEFAULT_METRICS } from "../src/metrics.js";

const [redisUrl, queuePrefix, databaseUrl] = process.argv.slice(2);
await startAnalysisWorker({
  port: 0, redisUrl: redisUrl!, queuePrefix: queuePrefix!, databaseUrl: databaseUrl!, engineCommand: "", poolSize: 1,
  engineHashMb: 16, depthTriage: 12, depthFull: 18, historyLimit: 20, apiToken: "", runWorker: true,
  rules: DEFAULT_RULES, metrics: DEFAULT_METRICS,
}, {
  concurrency: 1, lockDuration: 1_000, stalledInterval: 500,
  analyse: async () => {
    process.stdout.write("ACTIVE\n");
    return new Promise(() => {}); // ne rend jamais la main
  },
});
