import type pg from "pg";
import type { SngSnapshot } from "@chessarena/shared";
import { withTx } from "../db/tx.js";

/**
 * Persistance des tournois. `save` écrit l'état COMPLET (upsert) dans une seule
 * transaction : rejouer un même instantané est sans effet, et un instantané partiel
 * est impossible.
 */
export interface TournamentStore {
  save(s: SngSnapshot): Promise<void>;
  /** Démarrage serveur : tournois interrompus par un arrêt → `cancelled`. Retourne leurs ids. */
  cancelInterrupted(reason: string): Promise<string[]>;
}

export class PgTournamentStore implements TournamentStore {
  constructor(private readonly pool: pg.Pool) {}

  async save(s: SngSnapshot): Promise<void> {
    await withTx(this.pool, async (c) => {
      const users = s.players.map((p) => p.userId);
      if (users.length) {
        await c.query("INSERT INTO users (id, username) SELECT u, u FROM unnest($1::text[]) u ON CONFLICT (id) DO NOTHING", [users]);
      }
      const ranking = s.status === "finished"
        ? [...s.players].filter((p) => p.finalRank !== null).sort((a, b) => a.finalRank! - b.finalRank! || a.seed! - b.seed!).map((p) => p.userId)
        : null;
      await c.query(
        `INSERT INTO tournaments (id, format, size, time_control, currency, buy_in_cents, sponsor_added_cents, rake_bps,
                                  payout_structure_bps, status, cancel_reason, ranking, created_at, started_at, finished_at)
         VALUES ($1,'sit_and_go',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, cancel_reason = EXCLUDED.cancel_reason,
           ranking = EXCLUDED.ranking, sponsor_added_cents = EXCLUDED.sponsor_added_cents,
           started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at`,
        [s.id, s.size, s.timeControl, s.currency, s.buyInCents, s.sponsorAddedCents, s.rakeBps, s.payoutBps,
          s.status, s.cancelReason, ranking, s.createdAt, s.startedAt, s.finishedAt],
      );
      for (const p of s.players) {
        await c.query(
          `INSERT INTO tournament_entries (tournament_id, user_id, rating, seed, status, eliminated_round, final_rank, payout_cents)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (tournament_id, user_id) DO UPDATE SET rating = EXCLUDED.rating, seed = EXCLUDED.seed,
             status = EXCLUDED.status, eliminated_round = EXCLUDED.eliminated_round,
             final_rank = EXCLUDED.final_rank, payout_cents = EXCLUDED.payout_cents`,
          [s.id, p.userId, p.rating, p.seed, p.status === "locking" ? "registered" : p.status,
            p.eliminatedRound, p.finalRank, p.payoutCents],
        );
      }
      // joueurs désinscrits : absents de l'instantané, marqués comme tels
      await c.query(
        `UPDATE tournament_entries SET status = 'unregistered'
          WHERE tournament_id = $1 AND NOT (user_id = ANY($2::text[])) AND status <> 'unregistered'`,
        [s.id, users],
      );
      for (const round of s.rounds) {
        for (const m of round) {
          await c.query(
            `INSERT INTO tournament_matches (tournament_id, round, slot, player1, player2, winner, games, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (tournament_id, round, slot) DO UPDATE SET player1 = EXCLUDED.player1, player2 = EXCLUDED.player2,
               winner = EXCLUDED.winner, games = EXCLUDED.games, status = EXCLUDED.status`,
            [s.id, m.round, m.slot, m.p1, m.p2, m.winner, JSON.stringify(m.games), m.status],
          );
        }
      }
    });
  }

  async cancelInterrupted(reason: string): Promise<string[]> {
    const r = await this.pool.query<{ id: string }>(
      `UPDATE tournaments SET status = 'cancelled', cancel_reason = $1, finished_at = now()
        WHERE status IN ('registering', 'running') RETURNING id`, [reason],
    );
    if (r.rows.length) {
      await this.pool.query(
        `UPDATE tournament_entries SET status = 'refunded'
          WHERE tournament_id = ANY($1::uuid[]) AND status IN ('registered', 'playing')`, [r.rows.map((x) => x.id)],
      );
    }
    return r.rows.map((x) => x.id);
  }
}

export class InMemoryTournamentStore implements TournamentStore {
  readonly saved = new Map<string, SngSnapshot>();
  async save(s: SngSnapshot): Promise<void> {
    this.saved.set(s.id, structuredClone(s));
  }
  async cancelInterrupted(): Promise<string[]> {
    return [];
  }
}
