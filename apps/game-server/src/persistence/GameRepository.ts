import type pg from "pg";
import { DEFAULT_RATING, TIME_CONTROLS, type AccountState, type TimeControlId } from "@chessarena/shared";
import type { FinishedGame } from "../game/GameRoom.js";
import { withTx } from "../db/tx.js";
import {
  computeGameRatings, nextState, scoreFromResult, type RatingChange, type RatingState,
} from "../rating/elo.js";

/**
 * Persistance des parties et du classement.
 *
 * `recordGame` est IDEMPOTENT (clé = id de partie) et ATOMIQUE : la partie, les deux
 * classements et l'historique sont écrits dans une seule transaction SERIALIZABLE.
 * Un rejeu (retry après crash, double notification) renvoie le résultat déjà enregistré
 * sans recalculer — un Elo ne peut pas être appliqué deux fois.
 */
export interface RecordedGame {
  gameId: string;
  rated: boolean;
  /** variations Elo par userId (null si partie non classée) */
  changes: Record<string, RatingChange> | null;
  duplicate: boolean;
}

export interface GameRepository {
  ensureUser(userId: string): Promise<void>;
  /** état du compte EN BASE (source de vérité ; le JWT peut être périmé) */
  getAccountState(userId: string): Promise<AccountState>;
  getRatings(userId: string): Promise<Record<TimeControlId, RatingState>>;
  recordGame(g: FinishedGame): Promise<RecordedGame>;
}

const fresh = (): RatingState => ({ rating: DEFAULT_RATING, games: 0, peak: DEFAULT_RATING });
const TCS = Object.keys(TIME_CONTROLS) as TimeControlId[];

// ═════════════════════════════════════════════════════════════════════════════
export class PgGameRepository implements GameRepository {
  constructor(private readonly pool: pg.Pool) {}

  async ensureUser(userId: string): Promise<void> {
    await this.pool.query("INSERT INTO users (id, username) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING", [userId]);
  }

  async getAccountState(userId: string): Promise<AccountState> {
    const r = await this.pool.query<{ state: AccountState }>("SELECT state FROM users WHERE id = $1", [userId]);
    return r.rows[0]?.state ?? "active";
  }

  async getRatings(userId: string): Promise<Record<TimeControlId, RatingState>> {
    const r = await this.pool.query<{ time_control: TimeControlId; rating: number; games: number; peak: number }>(
      "SELECT time_control, rating, games, peak FROM ratings WHERE user_id = $1", [userId],
    );
    const out = Object.fromEntries(TCS.map((tc) => [tc, fresh()])) as Record<TimeControlId, RatingState>;
    for (const row of r.rows) out[row.time_control] = { rating: row.rating, games: row.games, peak: row.peak };
    return out;
  }

  async recordGame(g: FinishedGame): Promise<RecordedGame> {
    const tc = g.timeControl.id;
    const w = g.white.userId;
    const b = g.black.userId;

    return withTx(this.pool, async (c) => {
      const existing = await c.query<{
        rated: boolean; white_rating_before: number | null; white_rating_after: number | null;
        black_rating_before: number | null; black_rating_after: number | null;
      }>("SELECT rated, white_rating_before, white_rating_after, black_rating_before, black_rating_after FROM games WHERE id = $1", [g.gameId]);
      if (existing.rows[0]) {
        const e = existing.rows[0];
        const hist = await c.query<{ user_id: string; k_factor: number }>(
          "SELECT user_id, k_factor FROM rating_history WHERE game_id = $1", [g.gameId],
        );
        const k = new Map(hist.rows.map((h) => [h.user_id, h.k_factor]));
        const mk = (before: number | null, after: number | null, id: string): RatingChange =>
          ({ before: before!, after: after!, delta: after! - before!, k: k.get(id) ?? 0, expected: NaN });
        return {
          gameId: g.gameId, rated: e.rated, duplicate: true,
          changes: e.rated ? { [w]: mk(e.white_rating_before, e.white_rating_after, w), [b]: mk(e.black_rating_before, e.black_rating_after, b) } : null,
        };
      }

      await c.query("INSERT INTO users (id, username) SELECT u, u FROM unnest($1::text[]) u ON CONFLICT (id) DO NOTHING", [[w, b]]);

      let changes: Record<string, RatingChange> | null = null;
      if (g.rated) {
        await c.query(
          `INSERT INTO ratings (user_id, time_control) SELECT u, $2 FROM unnest($1::text[]) u
           ON CONFLICT (user_id, time_control) DO NOTHING`, [[w, b], tc],
        );
        // verrouillage dans un ordre déterministe : pas d'interblocage entre deux parties
        const rows = await c.query<{ user_id: string; rating: number; games: number; peak: number }>(
          `SELECT user_id, rating, games, peak FROM ratings
            WHERE time_control = $2 AND user_id = ANY($1::text[]) ORDER BY user_id FOR UPDATE`, [[w, b], tc],
        );
        const st = new Map(rows.rows.map((r) => [r.user_id, { rating: r.rating, games: r.games, peak: r.peak }]));
        const ws = st.get(w)!;
        const bs = st.get(b)!;
        const res = computeGameRatings(ws, bs, scoreFromResult(g.result));
        for (const [uid, s, ch] of [[w, ws, res.white], [b, bs, res.black]] as const) {
          const n = nextState(s, ch);
          await c.query(
            "UPDATE ratings SET rating = $3, games = $4, peak = $5, updated_at = now() WHERE user_id = $1 AND time_control = $2",
            [uid, tc, n.rating, n.games, n.peak],
          );
        }
        changes = { [w]: res.white, [b]: res.black };
      }

      await c.query(
        `INSERT INTO games (id, tournament_id, white_id, black_id, time_control, currency, buy_in_cents, rated,
                            result, termination, aborted_by, pgn, move_times_ms,
                            white_rating_before, white_rating_after, black_rating_before, black_rating_after)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [g.gameId, g.tournament?.tournamentId ?? null, w, b, tc, g.stake.currency, g.stake.buyInCents, g.rated,
          g.result, g.termination, g.abortedBy, g.pgn, g.moveTimesMs.map((x) => Math.round(x)),
          changes?.[w]?.before ?? null, changes?.[w]?.after ?? null, changes?.[b]?.before ?? null, changes?.[b]?.after ?? null],
      );

      if (changes) {
        const ws = scoreFromResult(g.result);
        await c.query(
          `INSERT INTO rating_history (user_id, time_control, game_id, rating_before, rating_after, k_factor, score)
           VALUES ($1,$3,$4,$5,$6,$7,$8), ($2,$3,$4,$9,$10,$11,$12)`,
          [w, b, tc, g.gameId,
            changes[w]!.before, changes[w]!.after, changes[w]!.k, ws,
            changes[b]!.before, changes[b]!.after, changes[b]!.k, 1 - ws],
        );
      }
      return { gameId: g.gameId, rated: g.rated, changes, duplicate: false };
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
export class InMemoryGameRepository implements GameRepository {
  readonly games = new Map<string, { game: FinishedGame; recorded: RecordedGame }>();
  private ratings = new Map<string, RatingState>();

  async ensureUser(): Promise<void> {}
  readonly states = new Map<string, AccountState>();
  async getAccountState(userId: string): Promise<AccountState> {
    return this.states.get(userId) ?? "active";
  }

  async getRatings(userId: string): Promise<Record<TimeControlId, RatingState>> {
    return Object.fromEntries(TCS.map((tc) => [tc, { ...(this.ratings.get(`${userId}|${tc}`) ?? fresh()) }])) as Record<TimeControlId, RatingState>;
  }

  async recordGame(g: FinishedGame): Promise<RecordedGame> {
    const prev = this.games.get(g.gameId);
    if (prev) return { ...prev.recorded, duplicate: true };
    let changes: Record<string, RatingChange> | null = null;
    if (g.rated) {
      const kw = `${g.white.userId}|${g.timeControl.id}`;
      const kb = `${g.black.userId}|${g.timeControl.id}`;
      const ws = this.ratings.get(kw) ?? fresh();
      const bs = this.ratings.get(kb) ?? fresh();
      const res = computeGameRatings(ws, bs, scoreFromResult(g.result));
      this.ratings.set(kw, nextState(ws, res.white));
      this.ratings.set(kb, nextState(bs, res.black));
      changes = { [g.white.userId]: res.white, [g.black.userId]: res.black };
    }
    const recorded: RecordedGame = { gameId: g.gameId, rated: g.rated, changes, duplicate: false };
    this.games.set(g.gameId, { game: g, recorded });
    return recorded;
  }
}
