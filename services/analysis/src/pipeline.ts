import { Chess } from "chess.js";
import type { AnalysisRequest, AnalysisResult, VerdictEvent } from "@chessarena/shared";
import type { AnalysisStore } from "./store.js";
import { evaluatePlayer, RULE_VERSION, type RuleConfig, type RuleOutcome } from "./rules.js";
import type { AnalysisJobData } from "./queue.js";

/**
 * Traitement d'UNE tâche d'analyse, indépendant de BullMQ (testable seul).
 *
 *  1. profondeur : imposée (confirmation) ou triage — 12 par défaut, 18–20 pour une
 *     partie en EUR ou un joueur sous surveillance ;
 *  2. analyse moteur (sautée si déjà en base à cette profondeur : rejouer est sans effet) ;
 *  3. règle de décision pour chacun des deux joueurs, sur son historique ;
 *  4. actions : réanalyses de confirmation et/ou verdicts vers le game-server.
 *
 * Tout est idempotent : une tâche interrompue (crash du worker) peut être rejouée
 * intégralement sans dupliquer ni analyse, ni verdict, ni réanalyse.
 */
export class PermanentJobError extends Error {}

export interface PipelineDeps {
  store: AnalysisStore;
  analyse(req: AnalysisRequest, depth: number): Promise<AnalysisResult>;
  enqueueConfirm(gameId: string, depth: number): Promise<void>;
  emitVerdict(v: VerdictEvent): Promise<void>;
  rules: RuleConfig;
  depthTriage: number;
  depthFull: number;
  historyLimit: number;
}

export interface JobOutcome {
  gameId: string;
  depth: number;
  analysed: boolean;
  players: Array<{ userId: string; outcome: RuleOutcome }>;
  confirmsQueued: string[];
  verdicts: VerdictEvent[];
}

export async function chooseDepth(req: AnalysisRequest, deps: Pick<PipelineDeps, "store" | "depthTriage" | "depthFull">): Promise<number> {
  if (req.currency === "EUR") return deps.depthFull;
  const [w, b] = await Promise.all([deps.store.isWatched(req.players.w.userId), deps.store.isWatched(req.players.b.userId)]);
  return w || b ? deps.depthFull : deps.depthTriage;
}

export async function processAnalysisJob(data: AnalysisJobData, deps: PipelineDeps): Promise<JobOutcome> {
  const req = data.request ?? (await deps.store.loadRequest(data.gameId));
  if (!req) throw new PermanentJobError(`partie ${data.gameId} : requête introuvable`);
  if (req.gameId !== data.gameId) throw new PermanentJobError("gameId incohérent");
  try {
    new Chess().loadPgn(req.pgn);
  } catch (e) {
    throw new PermanentJobError(`PGN invalide : ${(e as Error).message.slice(0, 120)}`);
  }

  const depth = data.depth ?? (await chooseDepth(req, deps));
  let analysed = false;
  if (!(await deps.store.hasAnalysis(req.gameId, depth))) {
    const result = await deps.analyse(req, depth);
    await deps.store.saveAnalysis(req, result);
    analysed = true;
  }

  const out: JobOutcome = { gameId: req.gameId, depth, analysed, players: [], confirmsQueued: [], verdicts: [] };
  for (const color of ["w", "b"] as const) {
    const userId = req.players[color].userId;
    const history = await deps.store.history(userId, deps.historyLimit);
    const outcome = evaluatePlayer(history, deps.rules);
    out.players.push({ userId, outcome });

    if (outcome.verdict === "CLEAN") continue;
    if (outcome.verdict === "CONFIRM") {
      for (const gid of outcome.needsDeepAnalysis) {
        await deps.enqueueConfirm(gid, deps.depthFull);
        out.confirmsQueued.push(gid);
      }
    }
    const v: VerdictEvent = {
      userId,
      level: outcome.verdict === "HOLD" ? "hold" : "watch",
      score: outcome.score,
      reasons: outcome.reasons,
      gameIds: outcome.windowGameIds,
      depth,
      ruleVersion: RULE_VERSION,
      at: new Date().toISOString(),
    };
    await deps.emitVerdict(v);
    out.verdicts.push(v);
  }
  return out;
}
