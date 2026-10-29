import type pg from "pg";
import type { AnalysisRequest, AnalysisResult } from "@chessarena/shared";
import type { GameStat } from "./rules.js";

/**
 * Accès base du service d'analyse. LECTURE des comptes, ÉCRITURE des seules
 * analyses : l'application des sanctions appartient au game-server (verdicts).
 */
export interface AnalysisStore {
  saveAnalysis(req: AnalysisRequest, r: AnalysisResult): Promise<"saved" | "duplicate">;
  /** historique chronologique, une ligne par partie, à la MEILLEURE profondeur disponible */
  history(userId: string, limit: number): Promise<GameStat[]>;
  /** joueur sous surveillance (dossier ouvert ou drapeau `fairplay_watch`) */
  isWatched(userId: string): Promise<boolean>;
  /** requête d'origine d'une partie déjà analysée (pour la réanalyse de confirmation) */
  loadRequest(gameId: string): Promise<AnalysisRequest | null>;
  hasAnalysis(gameId: string, depth: number): Promise<boolean>;
  getAnalysis(gameId: string): Promise<{ depth: number; engine: string; moves: unknown; stats: unknown[] }[]>;
}

export class PgAnalysisStore implements AnalysisStore {
  constructor(private readonly pool: pg.Pool) {}

  async saveAnalysis(req: AnalysisRequest, r: AnalysisResult): Promise<"saved" | "duplicate"> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const ins = await c.query(
        `INSERT INTO anticheat_analyses (game_id, depth, engine, request, moves, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (game_id, depth) DO NOTHING`,
        [r.gameId, r.depth, r.engine, JSON.stringify(req), JSON.stringify(r.moves), Math.round(r.durationMs)],
      );
      if (ins.rowCount === 0) {
        await c.query("ROLLBACK");
        return "duplicate";
      }
      // date de fin : celle de la partie enregistrée (source de vérité), sinon celle de la requête
      const ended = await c.query<{ ended_at: Date }>("SELECT ended_at FROM games WHERE id = $1", [r.gameId]);
      const endedAt = ended.rows[0]?.ended_at ?? (req.endedAt ? new Date(req.endedAt) : new Date());
      for (const p of r.players) {
        await c.query(
          `INSERT INTO anticheat_player_stats (game_id, depth, user_id, color, rating, currency, time_control, analysed_moves,
             acpl, engine_match_rate, time_mean_ms, time_variance, time_cv, focus_loss, game_ended_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [r.gameId, r.depth, p.userId, p.color, p.rating, req.currency, req.timeControl, p.analysedMoves,
            p.acpl, p.engineMatchRate, p.timeMeanMs, p.timeVariance, p.timeCv, p.focusLoss, endedAt],
        );
      }
      await c.query("COMMIT");
      return "saved";
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  async history(userId: string, limit: number): Promise<GameStat[]> {
    const r = await this.pool.query<{
      game_id: string; ended: Date; depth: number; rating: number; analysed_moves: number;
      acpl: string; engine_match_rate: string; time_cv: number; focus_loss: number;
    }>(
      `SELECT * FROM (
         SELECT DISTINCT ON (game_id) game_id, game_ended_at AS ended, depth, rating, analysed_moves,
                acpl, engine_match_rate, time_cv, focus_loss
           FROM anticheat_player_stats WHERE user_id = $1
          ORDER BY game_id, depth DESC
       ) best ORDER BY ended DESC, game_id DESC LIMIT $2`,
      [userId, limit],
    );
    return r.rows.reverse().map((x) => ({
      gameId: x.game_id, endedAt: x.ended.toISOString(), depth: x.depth, rating: x.rating,
      analysedMoves: x.analysed_moves, acpl: Number(x.acpl), engineMatchRate: Number(x.engine_match_rate),
      timeCv: x.time_cv, focusLoss: x.focus_loss,
    }));
  }

  async isWatched(userId: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM users WHERE id = $1 AND (fairplay_watch OR state = 'withdrawal_hold')
       UNION ALL SELECT 1 FROM anticheat_cases WHERE user_id = $1 AND status = 'open' LIMIT 1`, [userId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async loadRequest(gameId: string): Promise<AnalysisRequest | null> {
    const r = await this.pool.query<{ request: AnalysisRequest }>(
      "SELECT request FROM anticheat_analyses WHERE game_id = $1 ORDER BY depth DESC LIMIT 1", [gameId],
    );
    return r.rows[0]?.request ?? null;
  }

  async hasAnalysis(gameId: string, depth: number): Promise<boolean> {
    const r = await this.pool.query("SELECT 1 FROM anticheat_analyses WHERE game_id = $1 AND depth >= $2", [gameId, depth]);
    return (r.rowCount ?? 0) > 0;
  }

  async getAnalysis(gameId: string) {
    const a = await this.pool.query<{ depth: number; engine: string; moves: unknown }>(
      "SELECT depth, engine, moves FROM anticheat_analyses WHERE game_id = $1 ORDER BY depth DESC", [gameId],
    );
    const out = [];
    for (const row of a.rows) {
      const s = await this.pool.query("SELECT * FROM anticheat_player_stats WHERE game_id = $1 AND depth = $2", [gameId, row.depth]);
      out.push({ ...row, stats: s.rows });
    }
    return out;
  }
}
