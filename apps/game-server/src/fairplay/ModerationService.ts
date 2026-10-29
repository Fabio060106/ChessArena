import type pg from "pg";
import type {
  AccountState, CaseDetail, CaseGameView, CaseResolution, CaseSummary, Cents, Currency, DecisionResult, MoveAnalysis,
} from "@chessarena/shared";
import { withTx } from "../db/tx.js";
import { acct, type PgLedger, type Posting } from "../settlement/ledger.js";
import type { WithdrawalService } from "../settlement/withdrawals.js";
import type { AuditSink } from "../audit/auditLog.js";

/**
 * Arbitrage humain des dossiers anti-triche.
 *
 *   clean  — faux positif : WITHDRAWAL_HOLD levé, retraits retenus relâchés, surveillance arrêtée.
 *   watch  — doute : blocage levé, mais analyses profondes maintenues sur les parties suivantes.
 *   cheat  — triche confirmée, en UNE transaction :
 *              1. compte suspendu (ban) ;
 *              2. retraits non envoyés annulés (fonds rendus au solde) ;
 *              3. REDISTRIBUTION : chaque adversaire d'une partie à enjeu jouée depuis la
 *                 première partie suspecte est remboursé de sa perte nette exacte (mise −
 *                 gain reçu, lue dans l'écriture de règlement `settle:<gameId>`). Les fonds
 *                 viennent du solde du tricheur, le complément éventuel du fonds fair-play ;
 *              4. CONFISCATION du solde restant vers `house:confiscated:<CUR>` ;
 *              5. tournois concernés listés pour une redistribution manuelle (classements
 *                 à recalculer : hors périmètre automatique).
 *            Tout ou rien : si une étape échoue, rien n'est appliqué.
 *
 * Chaque décision est journalisée (moderation_decisions, append-only) et auditée (chaîne SHA-256).
 */
export class CaseNotFoundError extends Error {}
export class CaseAlreadyResolvedError extends Error {}

export interface ModerationHooks {
  /** après un bannissement : déconnecter le joueur */
  onBanned?(userId: string): void;
}

export class ModerationService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly ledger: PgLedger,
    private readonly withdrawals: WithdrawalService,
    private readonly audit?: AuditSink,
    private readonly hooks: ModerationHooks = {},
  ) {}

  async listCases(status: "open" | "resolved" = "open", limit = 100): Promise<CaseSummary[]> {
    const r = await this.pool.query(
      `SELECT c.*, u.state AS account_state,
              (SELECT count(DISTINCT game_id)::int FROM anticheat_player_stats s WHERE s.user_id = c.user_id) AS games_count,
              (SELECT COALESCE(SUM(amount_cents), 0)::bigint FROM withdrawal_requests w
                WHERE w.user_id = c.user_id AND w.status IN ('requested', 'on_hold')) AS pending_wd
         FROM anticheat_cases c JOIN users u ON u.id = c.user_id
        WHERE c.status = $1
        ORDER BY (c.level = 'hold') DESC, c.score DESC, c.updated_at DESC LIMIT $2`, [status, limit],
    );
    return r.rows.map(toSummary);
  }

  async getCase(caseId: string, recentGames = 12): Promise<CaseDetail> {
    const r = await this.pool.query(
      `SELECT c.*, u.state AS account_state,
              (SELECT count(DISTINCT game_id)::int FROM anticheat_player_stats s WHERE s.user_id = c.user_id) AS games_count,
              (SELECT COALESCE(SUM(amount_cents), 0)::bigint FROM withdrawal_requests w
                WHERE w.user_id = c.user_id AND w.status IN ('requested', 'on_hold')) AS pending_wd
         FROM anticheat_cases c JOIN users u ON u.id = c.user_id WHERE c.id = $1`, [caseId],
    );
    const row = r.rows[0];
    if (!row) throw new CaseNotFoundError(caseId);
    const triggers: string[] = row.trigger_game_ids;

    // parties récentes du joueur + parties déclencheuses, à la meilleure profondeur
    const games = await this.pool.query(
      `WITH best AS (
         SELECT DISTINCT ON (s.game_id) s.* FROM anticheat_player_stats s
          WHERE s.user_id = $1 ORDER BY s.game_id, s.depth DESC
       ), picked AS (
         SELECT * FROM best WHERE game_id = ANY($2::uuid[])
         UNION
         SELECT * FROM (SELECT * FROM best ORDER BY game_ended_at DESC LIMIT $3) recent
       )
       SELECT p.*, a.engine, a.moves, g.pgn, g.result, g.termination, g.buy_in_cents, g.white_id, g.black_id
         FROM picked p
         JOIN anticheat_analyses a ON a.game_id = p.game_id AND a.depth = p.depth
         JOIN games g ON g.id = p.game_id
        ORDER BY p.game_ended_at DESC`,
      [row.user_id, triggers, recentGames],
    );
    const decisions = await this.pool.query(
      "SELECT actor, action, note, details, created_at FROM moderation_decisions WHERE case_id = $1 ORDER BY id", [caseId],
    );
    return {
      ...toSummary(row),
      games: games.rows.map((g): CaseGameView => ({
        gameId: g.game_id,
        endedAt: g.game_ended_at.toISOString(),
        timeControl: g.time_control,
        currency: g.currency,
        buyInCents: Number(g.buy_in_cents),
        color: g.color,
        opponent: g.color === "w" ? g.black_id : g.white_id,
        result: g.result,
        termination: g.termination,
        ratingAtGame: g.rating,
        depth: g.depth,
        engine: g.engine,
        acpl: Number(g.acpl),
        engineMatchRate: Number(g.engine_match_rate),
        analysedMoves: g.analysed_moves,
        timeMeanMs: g.time_mean_ms,
        timeCv: g.time_cv,
        focusLoss: g.focus_loss,
        isTrigger: triggers.includes(g.game_id),
        moves: g.moves as MoveAnalysis[],
        pgn: g.pgn,
      })),
      decisions: decisions.rows.map((d) => ({ actor: d.actor, action: d.action, note: d.note, details: d.details, createdAt: d.created_at.toISOString() })),
    };
  }

  async decide(caseId: string, moderatorId: string, decision: CaseResolution, note: string): Promise<DecisionResult> {
    if (!["clean", "watch", "cheat"].includes(decision)) throw new Error("décision invalide");
    if (!note || note.trim().length < 5) throw new Error("motif obligatoire (5 caractères minimum)");

    const posted: Array<{ key: string; currency: Currency; transactionId: string; postings: Posting[]; meta: Record<string, unknown> }> = [];
    let userId = "";
    const result = await withTx(this.pool, async (c) => {
      posted.length = 0;
      const cs = await c.query<{ user_id: string; status: string; trigger_game_ids: string[] }>(
        "SELECT user_id, status, trigger_game_ids FROM anticheat_cases WHERE id = $1 FOR UPDATE", [caseId],
      );
      const kase = cs.rows[0];
      if (!kase) throw new CaseNotFoundError(caseId);
      if (kase.status !== "open") throw new CaseAlreadyResolvedError(caseId);
      userId = kase.user_id;
      await c.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [userId]);

      const out: DecisionResult = { caseId, decision, refunds: [], confiscated: {}, cancelledWithdrawals: 0, releasedWithdrawals: 0 };
      const post = async (key: string, currency: Currency, postings: Posting[], meta: Record<string, unknown>) => {
        const r = await this.ledger.postWithin(c, key, currency, postings, meta);
        if (r.status === "applied") posted.push({ key, currency, transactionId: r.transactionId, postings, meta });
      };

      if (decision === "clean" || decision === "watch") {
        await c.query(
          "UPDATE users SET state = CASE WHEN state = 'withdrawal_hold' THEN 'active' ELSE state END, fairplay_watch = $2 WHERE id = $1",
          [userId, decision === "watch"],
        );
        out.releasedWithdrawals = await this.withdrawals.releaseWithin(c, userId);
      } else {
        await c.query("UPDATE users SET state = 'suspended', fairplay_watch = false WHERE id = $1", [userId]);
        out.cancelledWithdrawals = await this.withdrawals.cancelAllWithin(c, userId, `fairplay_ban:${caseId}`);

        // période revue : depuis la première partie déclencheuse
        const from = await c.query<{ m: Date | null }>("SELECT min(ended_at) AS m FROM games WHERE id = ANY($1::uuid[])", [kase.trigger_game_ids]);
        const since = from.rows[0]?.m ?? new Date(0);

        const balances = new Map<Currency, Cents>();
        for (const cur of ["EUR", "PLAY"] as const) {
          const b = await c.query<{ b: string }>("SELECT balance_cents AS b FROM ledger_accounts WHERE account = $1", [acct.user(userId, cur)]);
          balances.set(cur, Number(b.rows[0]?.b ?? 0));
        }

        // 3. redistribution aux adversaires des duels à enjeu
        const duels = await c.query<{ id: string; currency: Currency; white_id: string; black_id: string; buy_in_cents: string }>(
          `SELECT id, currency, white_id, black_id, buy_in_cents FROM games
            WHERE (white_id = $1 OR black_id = $1) AND tournament_id IS NULL AND buy_in_cents > 0 AND ended_at >= $2
            ORDER BY ended_at`, [userId, since],
        );
        for (const g of duels.rows) {
          const victim = g.white_id === userId ? g.black_id : g.white_id;
          const settle = await c.query<{ account: string; amount: string }>(
            `SELECT e.account, e.amount_cents AS amount FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
              WHERE t.idempotency_key = $1 AND e.account = $2`, [`settle:${g.id}`, acct.user(victim, g.currency)],
          );
          const received = settle.rows.reduce((a, x) => a + Number(x.amount), 0);
          const loss = Number(g.buy_in_cents) - received;
          if (loss <= 0) continue; // l'adversaire n'a rien perdu (victoire, partie annulée)
          const available = balances.get(g.currency) ?? 0;
          const fromCheater = Math.min(loss, available);
          const fromFund = loss - fromCheater;
          balances.set(g.currency, available - fromCheater);
          const postings: Posting[] = [{ account: acct.user(victim, g.currency), amountCents: loss }];
          if (fromCheater > 0) postings.push({ account: acct.user(userId, g.currency), amountCents: -fromCheater });
          if (fromFund > 0) postings.push({ account: acct.fairplayFund(g.currency), amountCents: -fromFund });
          await post(`fairplay-refund:${caseId}:${g.id}`, g.currency, postings, { kind: "fairplay_refund", caseId, gameId: g.id, victim, fromCheater, fromFund });
          out.refunds.push({ gameId: g.id, userId: victim, currency: g.currency, amountCents: loss });
        }

        // 4. confiscation du solde restant
        for (const [cur, left] of balances) {
          if (left <= 0) continue;
          await post(`fairplay-confiscate:${caseId}:${cur}`, cur, [
            { account: acct.user(userId, cur), amountCents: -left },
            { account: acct.confiscated(cur), amountCents: left },
          ], { kind: "fairplay_confiscation", caseId, userId });
          out.confiscated[cur] = left;
        }
      }

      // 5. tournois à revoir manuellement
      const tournaments = decision === "cheat"
        ? (await c.query<{ id: string }>(
            `SELECT DISTINCT t.id FROM tournament_entries e JOIN tournaments t ON t.id = e.tournament_id
              WHERE e.user_id = $1 AND t.status = 'finished' AND t.finished_at >= (SELECT coalesce(min(ended_at), 'epoch') FROM games WHERE id = ANY($2::uuid[]))`,
            [userId, kase.trigger_game_ids])).rows.map((x) => x.id)
        : [];

      await c.query(
        "UPDATE anticheat_cases SET status = 'resolved', resolution = $2, resolved_by = $3, resolved_at = now(), updated_at = now() WHERE id = $1",
        [caseId, decision, moderatorId],
      );
      await c.query(
        "INSERT INTO moderation_decisions (case_id, user_id, actor, action, note, details) VALUES ($1, $2, $3, $4, $5, $6)",
        [caseId, userId, moderatorId, decision, note.trim(), JSON.stringify({ ...out, tournamentsToReview: tournaments })],
      );
      return out;
    });

    // après COMMIT : audit + effets temps réel
    for (const p of posted) this.ledger.auditPost(p.key, p.currency, p.transactionId, p.postings, p.meta);
    this.audit?.append("moderation.decision", { caseId, userId, moderatorId, decision, note: note.trim(), refunds: result.refunds, confiscated: result.confiscated });
    if (decision === "cheat") this.hooks.onBanned?.(userId);
    return result;
  }
}

function toSummary(row: Record<string, any>): CaseSummary {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    level: row.level,
    score: row.score,
    reasons: row.reasons,
    accountState: row.account_state as AccountState,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    resolution: row.resolution,
    gamesCount: row.games_count ?? 0,
    pendingWithdrawalCents: Number(row.pending_wd ?? 0),
  };
}
