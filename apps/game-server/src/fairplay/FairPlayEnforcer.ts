import type pg from "pg";
import { Worker, type ConnectionOptions } from "bullmq";
import { VERDICT_QUEUE, type VerdictEvent } from "@chessarena/shared";
import { withTx } from "../db/tx.js";
import type { AuditSink } from "../audit/auditLog.js";

/**
 * Application des verdicts du service d'analyse (file `fairplay-verdicts`).
 *
 * Le service d'analyse DÉTECTE, le game-server APPLIQUE : il est le seul à modifier
 * l'état d'un compte. Un verdict :
 *   • `watch` → dossier ouvert (ou mis à jour), `fairplay_watch = true` : toutes les
 *     parties suivantes du joueur sont analysées en profondeur ;
 *   • `hold`  → dossier escaladé + compte en WITHDRAWAL_HOLD : les retraits sont
 *     retenus (WithdrawalService), le JEU CONTINUE. Aucune notification au joueur.
 *
 * Idempotent : rejouer un verdict ne crée ni dossier ni décision supplémentaire.
 * Un verdict portant sur des parties déjà jugées « clean » par un modérateur est ignoré
 * (le joueur n'est pas re-sanctionné pour les mêmes faits).
 */
export type EnforcementAction = "opened" | "escalated" | "updated" | "ignored_already_judged" | "ignored_closed_account";

export class FairPlayEnforcer {
  constructor(private readonly pool: pg.Pool, private readonly audit?: AuditSink) {}

  async apply(v: VerdictEvent): Promise<{ action: EnforcementAction; caseId: string | null }> {
    const result = await withTx(this.pool, async (c) => {
      await c.query("INSERT INTO users (id, username) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING", [v.userId]);
      const user = await c.query<{ state: string }>("SELECT state FROM users WHERE id = $1 FOR UPDATE", [v.userId]);
      const state = user.rows[0]!.state;
      if (state === "suspended" || state === "closed") return { action: "ignored_closed_account" as const, caseId: null };

      const judged = await c.query(
        `SELECT 1 FROM anticheat_cases WHERE user_id = $1 AND status = 'resolved' AND resolution IN ('clean', 'watch')
            AND trigger_game_ids @> $2::uuid[] LIMIT 1`, [v.userId, v.gameIds],
      );
      if ((judged.rowCount ?? 0) > 0) return { action: "ignored_already_judged" as const, caseId: null };

      const open = await c.query<{ id: string; level: "watch" | "hold" }>(
        "SELECT id, level FROM anticheat_cases WHERE user_id = $1 AND status = 'open' FOR UPDATE", [v.userId],
      );
      let caseId: string;
      let action: EnforcementAction;
      if (!open.rows[0]) {
        const ins = await c.query<{ id: string }>(
          `INSERT INTO anticheat_cases (user_id, status, level, score, reasons, trigger_game_ids)
           VALUES ($1, 'open', $2, $3, $4, $5::uuid[]) RETURNING id`, [v.userId, v.level, v.score, v.reasons, v.gameIds],
        );
        caseId = ins.rows[0]!.id;
        action = "opened";
        await c.query(
          "INSERT INTO moderation_decisions (case_id, user_id, actor, action, details) VALUES ($1, $2, 'system:analysis', $3, $4)",
          [caseId, v.userId, v.level === "hold" ? "escalate_hold" : "open_watch", JSON.stringify(v)],
        );
      } else {
        caseId = open.rows[0].id;
        const escalate = v.level === "hold" && open.rows[0].level === "watch";
        // la gravité ne redescend jamais automatiquement : seul un modérateur la baisse
        await c.query(
          `UPDATE anticheat_cases SET level = CASE WHEN $2 = 'hold' THEN 'hold' ELSE level END,
             score = GREATEST(score, $3), reasons = $4, trigger_game_ids = $5::uuid[], updated_at = now()
           WHERE id = $1`, [caseId, v.level, v.score, v.reasons, v.gameIds],
        );
        action = escalate ? "escalated" : "updated";
        if (escalate) {
          await c.query(
            "INSERT INTO moderation_decisions (case_id, user_id, actor, action, details) VALUES ($1, $2, 'system:analysis', 'escalate_hold', $3)",
            [caseId, v.userId, JSON.stringify(v)],
          );
        }
      }

      await c.query("UPDATE users SET fairplay_watch = true WHERE id = $1", [v.userId]);
      if (v.level === "hold" && state === "active") {
        await c.query("UPDATE users SET state = 'withdrawal_hold' WHERE id = $1", [v.userId]);
      }
      return { action, caseId };
    });

    if (result.action === "opened" || result.action === "escalated") {
      this.audit?.append(v.level === "hold" ? "account.hold" : "anticheat.flag", {
        userId: v.userId, caseId: result.caseId, level: v.level, score: v.score, gameIds: v.gameIds, ruleVersion: v.ruleVersion,
      });
    }
    return result;
  }

  /** Consommateur BullMQ (concurrence 1 : les verdicts d'un même joueur restent ordonnés). */
  startWorker(connection: ConnectionOptions, prefix: string): Worker<VerdictEvent> {
    const w = new Worker<VerdictEvent>(VERDICT_QUEUE, async (job) => this.apply(job.data), { connection, prefix, concurrency: 1 });
    w.on("failed", (job, err) => console.error(`[fairplay] verdict ${job?.id} en échec : ${err.message}`));
    return w;
  }
}
