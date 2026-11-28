import type pg from "pg";
import type { SngSnapshot, TournamentCard, TournamentHistoryItem } from "@chessarena/shared";
import { withTx } from "../db/tx.js";

/**
 * Persistance des tournois. `save` écrit l'état COMPLET (upsert) dans une seule
 * transaction : rejouer un même instantané est sans effet, et un instantané partiel
 * est impossible.
 */
export interface TournamentStore {
  save(s: SngSnapshot): Promise<void>;
  /** Démarrage serveur : tournois interrompus par un arrêt → `cancelled`. Retourne leurs ids. */
  cancelInterrupted(reason: string, keep?: readonly string[]): Promise<string[]>;
  /** Tournois créés par des joueurs encore en inscription (repris au démarrage). */
  loadOpenCustom(): Promise<SngSnapshot[]>;
  /** Tournois créés par des joueurs en cours (repris au démarrage). */
  loadRunningCustom(): Promise<SngSnapshot[]>;
  /** Dernier instantané enregistré (null si inconnu). */
  load(id: string): Promise<SngSnapshot | null>;
  /** Tournois d'un joueur, les plus récents d'abord (inscrits, joués, annulés ; pas les désinscriptions). */
  listFor(userId: string, limit: number): Promise<TournamentHistoryItem[]>;
  /** Tournois de joueurs terminés récemment (page « Tournois »). */
  recentFinished(limit: number, clubSlug?: string): Promise<SngSnapshot[]>;
}

/** Résumé léger d'un tournoi (page « Tournois »). */
export function tournamentCard(s: SngSnapshot): TournamentCard {
  const active = s.players.filter((p) => p.status !== "unregistered" && p.status !== "refunded");
  const pts = (p: SngSnapshot["players"][number]) => p.points ?? null;
  const ordered = s.status === "finished"
    ? [...active].filter((p) => p.finalRank).sort((a, b) => a.finalRank! - b.finalRank!)
    : s.system === "swiss" || s.system === "arena"
      ? [...active].sort((a, b) => (b.points ?? 0) - (a.points ?? 0) || (b.buchholz ?? 0) - (a.buchholz ?? 0) || b.rating - a.rating)
      : [];
  return {
    id: s.id, name: s.name ?? null, createdBy: s.createdBy ?? null, system: s.system ?? "ko", timeControl: s.timeControl, status: s.status,
    size: s.size, players: active.length, buyInCents: s.buyInCents, currency: s.currency, startsAt: s.startsAt ?? null, repeatWeekly: !!s.repeatWeekly, club: s.club ?? null,
    teams: s.teamBattle ? s.teamBattle.teams.map((t) => ({ slug: t.slug, name: t.name, score: t.score })) : null,
    arenaMinutes: s.arenaMinutes ?? null, arenaEndsAt: s.arenaEndsAt ?? null, totalRounds: s.totalRounds ?? null, currentRound: s.currentRound,
    createdAt: s.createdAt, finishedAt: s.finishedAt,
    leaders: (s.status === "registering" ? [] : ordered.slice(0, 3)).map((p) => ({ userId: p.userId, points: pts(p) })),
  };
}

/** Ligne d'historique tirée d'un instantané. */
export function historyItem(s: SngSnapshot, userId: string): TournamentHistoryItem {
  const me = s.players.find((p) => p.userId === userId);
  return {
    id: s.id, name: s.name ?? null, createdBy: s.createdBy ?? null, system: s.system ?? "ko", timeControl: s.timeControl, status: s.status,
    players: s.players.filter((p) => p.seed !== null).length || s.players.filter((p) => p.status !== "unregistered" && p.status !== "refunded").length,
    rank: me?.finalRank ?? null, points: me?.points ?? null, payoutCents: me?.payoutCents ?? 0, currency: s.currency,
    createdAt: s.createdAt, finishedAt: s.finishedAt,
  };
}

export class PgTournamentStore implements TournamentStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * La colonne `snapshot` (migration 016) existe-t-elle ? Si le serveur démarre sans avoir appliqué la migration
   * (MIGRATE_ON_START absent), les tournois fonctionnent comme avant : enregistrement sans instantané,
   * pas de page de tournoi terminé, pas de reprise après redémarrage.
   */
  private snapshotColumn: Promise<boolean> | null = null;
  private hasSnapshot(): Promise<boolean> {
    this.snapshotColumn ??= this.pool
      .query("SELECT 1 FROM information_schema.columns WHERE table_name = 'tournaments' AND column_name = 'snapshot'")
      .then((r) => {
        if (!r.rowCount) console.warn("[tournois] colonne snapshot absente (migration 016 non appliquée) : pages de tournoi terminé et reprise désactivées");
        return (r.rowCount ?? 0) > 0;
      })
      .catch((e) => { this.snapshotColumn = null; throw e; });
    return this.snapshotColumn;
  }

  async save(s: SngSnapshot): Promise<void> {
    const snap = await this.hasSnapshot();
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
                                  payout_structure_bps, status, cancel_reason, ranking, created_at, started_at, finished_at${snap ? ", snapshot" : ""})
         VALUES ($1,$15,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14${snap ? ",$16" : ""})
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, cancel_reason = EXCLUDED.cancel_reason,${snap ? " snapshot = EXCLUDED.snapshot," : ""}
           ranking = EXCLUDED.ranking, sponsor_added_cents = EXCLUDED.sponsor_added_cents,
           started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at`,
        [s.id, s.size, s.timeControl, s.currency, s.buyInCents, s.sponsorAddedCents, s.rakeBps, s.payoutBps,
          s.status, s.cancelReason, ranking, s.createdAt, s.startedAt, s.finishedAt, s.system === "swiss" ? "swiss" : s.system === "arena" ? "arena" : "sit_and_go", ...(snap ? [JSON.stringify(s)] : [])],
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

  async cancelInterrupted(reason: string, keep: readonly string[] = []): Promise<string[]> {
    const r = await this.pool.query<{ id: string }>(
      `UPDATE tournaments SET status = 'cancelled', cancel_reason = $1, finished_at = now()
        WHERE status IN ('registering', 'running') AND NOT (id = ANY($2::uuid[])) RETURNING id`, [reason, [...keep]],
    );
    if (r.rows.length) {
      await this.pool.query(
        `UPDATE tournament_entries SET status = 'refunded'
          WHERE tournament_id = ANY($1::uuid[]) AND status IN ('registered', 'playing')`, [r.rows.map((x) => x.id)],
      );
    }
    return r.rows.map((x) => x.id);
  }

  async recentFinished(limit: number, clubSlug?: string): Promise<SngSnapshot[]> {
    if (!(await this.hasSnapshot())) return [];
    const r = await this.pool.query<{ snapshot: SngSnapshot }>(
      `SELECT snapshot FROM tournaments WHERE status = 'finished' AND snapshot IS NOT NULL AND snapshot->>'createdBy' IS NOT NULL
          AND ($2::text IS NULL OR snapshot->'club'->>'slug' = $2 OR snapshot->'teamBattle'->'teams' @> jsonb_build_array(jsonb_build_object('slug', $2::text)))
        ORDER BY finished_at DESC NULLS LAST LIMIT $1`, [Math.max(1, Math.min(50, limit)), clubSlug ?? null]);
    return r.rows.map((x) => x.snapshot);
  }

  async loadRunningCustom(): Promise<SngSnapshot[]> {
    if (!(await this.hasSnapshot())) return [];
    const r = await this.pool.query<{ snapshot: SngSnapshot }>(
      `SELECT snapshot FROM tournaments WHERE status = 'running' AND snapshot IS NOT NULL
          AND snapshot->>'createdBy' IS NOT NULL AND snapshot->>'status' = 'running'`);
    return r.rows.map((x) => x.snapshot);
  }

  async loadOpenCustom(): Promise<SngSnapshot[]> {
    if (!(await this.hasSnapshot())) return [];
    const r = await this.pool.query<{ snapshot: SngSnapshot }>(
      `SELECT snapshot FROM tournaments WHERE status = 'registering' AND snapshot IS NOT NULL
          AND snapshot->>'createdBy' IS NOT NULL AND snapshot->>'status' = 'registering'`);
    return r.rows.map((x) => x.snapshot);
  }

  async load(id: string): Promise<SngSnapshot | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id) || !(await this.hasSnapshot())) return null;
    const r = await this.pool.query<{ snapshot: SngSnapshot | null; status: SngSnapshot["status"]; cancel_reason: string | null }>(
      "SELECT snapshot, status, cancel_reason FROM tournaments WHERE id = $1", [id]);
    const row = r.rows[0];
    if (!row?.snapshot) return null;
    // un arrêt du serveur a pu annuler le tournoi après le dernier instantané
    return row.status === row.snapshot.status ? row.snapshot : { ...row.snapshot, status: row.status, cancelReason: row.cancel_reason };
  }

  async listFor(userId: string, limit: number): Promise<TournamentHistoryItem[]> {
    if (!(await this.hasSnapshot())) return [];
    const r = await this.pool.query<{ snapshot: SngSnapshot; status: SngSnapshot["status"]; cancel_reason: string | null }>(
      `SELECT t.snapshot, t.status, t.cancel_reason FROM tournaments t
         JOIN tournament_entries e ON e.tournament_id = t.id
        WHERE e.user_id = $1 AND e.status <> 'unregistered' AND t.snapshot IS NOT NULL
        ORDER BY t.created_at DESC LIMIT $2`, [userId, Math.max(1, Math.min(100, limit))]);
    return r.rows.map((x) => historyItem(x.status === x.snapshot.status ? x.snapshot : { ...x.snapshot, status: x.status, cancelReason: x.cancel_reason }, userId));
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
  async loadOpenCustom(): Promise<SngSnapshot[]> {
    return [];
  }
  async loadRunningCustom(): Promise<SngSnapshot[]> {
    return [];
  }
  async recentFinished(limit: number, clubSlug?: string): Promise<SngSnapshot[]> {
    return [...this.saved.values()].filter((s) => s.status === "finished" && s.createdBy && (!clubSlug || s.club?.slug === clubSlug || !!s.teamBattle?.teams.some((t) => t.slug === clubSlug)))
      .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? "")).slice(0, limit);
  }
  async load(id: string): Promise<SngSnapshot | null> {
    return this.saved.get(id) ?? null;
  }
  async listFor(userId: string, limit: number): Promise<TournamentHistoryItem[]> {
    return [...this.saved.values()]
      .filter((s) => s.players.some((p) => p.userId === userId && p.status !== "unregistered"))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((s) => historyItem(s, userId));
  }
}
