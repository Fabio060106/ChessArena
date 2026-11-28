import type pg from "pg";
import type { Pick } from "./odds.js";

export interface Bet {
  id: string;
  userId: string;
  market: string;
  relayId: string;
  pick: Pick;
  stakeCents: number;
  odds: number;
  ply: number;
  label: string;
  status: "open" | "won" | "lost" | "void";
  payoutCents: number;
  createdAt: string;
  settledAt: string | null;
}

export interface BetStore {
  insert(b: Bet): Promise<void>;
  openFor(market: string): Promise<Bet[]>;
  openMarkets(): Promise<string[]>;
  forUser(userId: string, limit: number): Promise<Bet[]>;
  /** passe un pari ouvert à son état final ; false s'il était déjà réglé (idempotent) */
  settle(id: string, status: Bet["status"], payoutCents: number): Promise<boolean>;
  /** meilleurs pronostiqueurs : gain net (gains − mises) sur les paris réglés depuis `since` */
  leaders(sinceIso: string, limit: number): Promise<Array<{ userId: string; netCents: number; bets: number; won: number }>>;
}

type Row = { id: string; user_id: string; market: string; relay_id: string; pick: Pick; stake_cents: number; odds: string; ply: number; label: string; status: Bet["status"]; payout_cents: number; created_at: Date; settled_at: Date | null };
const toBet = (r: Row): Bet => ({
  id: r.id, userId: r.user_id, market: r.market, relayId: r.relay_id, pick: r.pick, stakeCents: r.stake_cents, odds: Number(r.odds), ply: r.ply, label: r.label,
  status: r.status, payoutCents: r.payout_cents, createdAt: r.created_at.toISOString(), settledAt: r.settled_at?.toISOString() ?? null,
});

export class PgBetStore implements BetStore {
  constructor(private readonly pool: pg.Pool) {}
  async insert(b: Bet) {
    await this.pool.query(
      `INSERT INTO relay_bets (id, user_id, market, relay_id, pick, stake_cents, odds, ply, label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [b.id, b.userId, b.market, b.relayId, b.pick, b.stakeCents, b.odds, b.ply, b.label]);
  }
  async openFor(market: string) {
    return (await this.pool.query<Row>("SELECT * FROM relay_bets WHERE market = $1 AND status = 'open'", [market])).rows.map(toBet);
  }
  async openMarkets() {
    return (await this.pool.query<{ market: string }>("SELECT DISTINCT market FROM relay_bets WHERE status = 'open'")).rows.map((r) => r.market);
  }
  async forUser(userId: string, limit: number) {
    return (await this.pool.query<Row>("SELECT * FROM relay_bets WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2", [userId, limit])).rows.map(toBet);
  }
  async settle(id: string, status: Bet["status"], payoutCents: number) {
    const r = await this.pool.query("UPDATE relay_bets SET status = $2, payout_cents = $3, settled_at = now() WHERE id = $1 AND status = 'open'", [id, status, payoutCents]);
    return (r.rowCount ?? 0) > 0;
  }
  async leaders(sinceIso: string, limit: number) {
    const r = await this.pool.query<{ user_id: string; net: string; bets: string; won: string }>(
      `SELECT user_id, sum(payout_cents - stake_cents) AS net, count(*) AS bets, count(*) FILTER (WHERE status = 'won') AS won
         FROM relay_bets WHERE status IN ('won', 'lost') AND settled_at >= $1
        GROUP BY user_id ORDER BY net DESC, won DESC LIMIT $2`, [sinceIso, limit]);
    return r.rows.map((x) => ({ userId: x.user_id, netCents: Number(x.net), bets: Number(x.bets), won: Number(x.won) }));
  }
}

export class InMemoryBetStore implements BetStore {
  readonly all = new Map<string, Bet>();
  async insert(b: Bet) { this.all.set(b.id, { ...b }); }
  async openFor(market: string) { return [...this.all.values()].filter((b) => b.market === market && b.status === "open"); }
  async openMarkets() { return [...new Set([...this.all.values()].filter((b) => b.status === "open").map((b) => b.market))]; }
  async forUser(userId: string, limit: number) {
    return [...this.all.values()].filter((b) => b.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  async settle(id: string, status: Bet["status"], payoutCents: number) {
    const b = this.all.get(id);
    if (!b || b.status !== "open") return false;
    b.status = status; b.payoutCents = payoutCents; b.settledAt = new Date().toISOString();
    return true;
  }
  async leaders(sinceIso: string, limit: number) {
    const m = new Map<string, { userId: string; netCents: number; bets: number; won: number }>();
    for (const b of this.all.values()) {
      if ((b.status !== "won" && b.status !== "lost") || (b.settledAt ?? "") < sinceIso) continue;
      const r = m.get(b.userId) ?? { userId: b.userId, netCents: 0, bets: 0, won: 0 };
      r.netCents += b.payoutCents - b.stakeCents; r.bets++; if (b.status === "won") r.won++;
      m.set(b.userId, r);
    }
    return [...m.values()].sort((a, b) => b.netCents - a.netCents || b.won - a.won).slice(0, limit);
  }
}
