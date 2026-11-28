import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { ClubDetail, ClubMember, ClubSummary } from "@chessarena/shared";
import { withTx } from "../db/tx.js";

/**
 * Clubs : création (nom → adresse unique), adhésion par lien, départ, liste des membres avec leur Elo.
 * Règles : nom de 3 à 40 caractères, description ≤ 280, 2 clubs créés au plus par joueur,
 * 20 clubs au plus par joueur, le fondateur ne peut pas quitter son club.
 */
export class ClubError extends Error {
  constructor(readonly code: "BAD_NAME" | "BAD_DESCRIPTION" | "TOO_MANY_CLUBS" | "UNKNOWN_CLUB" | "ALREADY_MEMBER" | "NOT_MEMBER" | "OWNER_CANNOT_LEAVE") {
    super(code);
  }
}

export const CLUB_LIMITS = { maxOwned: 2, maxJoined: 20 } as const;

/** « Échiquier Club de Port-de-Bouc » → « echiquier-club-de-port-de-bouc » */
export function slugify(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "club";
}

export function cleanName(raw: unknown): string {
  const n = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (n.length < 3 || n.length > 40 || /[<>]/.test(n)) throw new ClubError("BAD_NAME");
  return n;
}
export function cleanDescription(raw: unknown): string {
  const d = typeof raw === "string" ? raw.replace(/[ \t]+/g, " ").trim() : "";
  if (d.length > 280 || /[<>]/.test(d)) throw new ClubError("BAD_DESCRIPTION");
  return d;
}

export interface ClubStore {
  list(limit: number): Promise<ClubSummary[]>;
  mine(userId: string): Promise<ClubSummary[]>;
  get(slug: string): Promise<ClubDetail | null>;
  create(userId: string, name: string, description: string): Promise<ClubSummary>;
  join(slug: string, userId: string): Promise<void>;
  leave(slug: string, userId: string): Promise<void>;
  isMember(slug: string, userId: string): Promise<boolean>;
}

interface Row { slug: string; name: string; description: string; created_by: string; created_at: Date; member_count: string | number }
const summary = (r: Row): ClubSummary => ({
  slug: r.slug, name: r.name, description: r.description, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString(), memberCount: Number(r.member_count),
});
const SELECT = `SELECT c.slug, c.name, c.description, c.created_by, c.created_at, (SELECT count(*) FROM club_members m WHERE m.club_id = c.id) AS member_count FROM clubs c`;

export class PgClubStore implements ClubStore {
  constructor(private readonly pool: pg.Pool) {}

  async list(limit: number): Promise<ClubSummary[]> {
    const r = await this.pool.query<Row>(`${SELECT} ORDER BY member_count DESC, c.created_at DESC LIMIT $1`, [Math.max(1, Math.min(200, limit))]);
    return r.rows.map(summary);
  }
  async mine(userId: string): Promise<ClubSummary[]> {
    const r = await this.pool.query<Row>(`${SELECT} JOIN club_members me ON me.club_id = c.id AND me.user_id = $1 ORDER BY me.joined_at`, [userId]);
    return r.rows.map(summary);
  }
  async get(slug: string): Promise<ClubDetail | null> {
    const r = await this.pool.query<Row & { id: string }>(`SELECT c.id, ${SELECT.slice("SELECT ".length)} WHERE c.slug = $1`, [slug]);
    const row = r.rows[0];
    if (!row) return null;
    const m = await this.pool.query<{ user_id: string; role: "owner" | "member"; joined_at: Date; blitz: number | null; rapid: number | null; games: string | null }>(
      `SELECT m.user_id, m.role, m.joined_at,
              (SELECT rating FROM ratings WHERE user_id = m.user_id AND time_control = 'blitz_3_0') AS blitz,
              (SELECT rating FROM ratings WHERE user_id = m.user_id AND time_control = 'rapid_5_0') AS rapid,
              (SELECT sum(games) FROM ratings WHERE user_id = m.user_id) AS games
         FROM club_members m WHERE m.club_id = $1`, [row.id]);
    const members: ClubMember[] = m.rows.map((x) => ({
      userId: x.user_id, role: x.role, joinedAt: new Date(x.joined_at).toISOString(), blitz: x.blitz ?? 1500, rapid: x.rapid ?? 1500, games: Number(x.games ?? 0),
    }));
    return { ...summary(row), members };
  }
  async create(userId: string, name: string, description: string): Promise<ClubSummary> {
    return withTx(this.pool, async (c) => {
      const owned = await c.query<{ n: string }>("SELECT count(*) AS n FROM clubs WHERE created_by = $1", [userId]);
      if (Number(owned.rows[0]!.n) >= CLUB_LIMITS.maxOwned) throw new ClubError("TOO_MANY_CLUBS");
      const joined = await c.query<{ n: string }>("SELECT count(*) AS n FROM club_members WHERE user_id = $1", [userId]);
      if (Number(joined.rows[0]!.n) >= CLUB_LIMITS.maxJoined) throw new ClubError("TOO_MANY_CLUBS");
      const base = slugify(name);
      let slug = base;
      for (let i = 2; (await c.query("SELECT 1 FROM clubs WHERE slug = $1", [slug])).rowCount; i++) slug = `${base}-${i}`;
      const id = randomUUID();
      await c.query("INSERT INTO users (id, username) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING", [userId]);
      await c.query("INSERT INTO clubs (id, slug, name, description, created_by) VALUES ($1, $2, $3, $4, $5)", [id, slug, name, description, userId]);
      await c.query("INSERT INTO club_members (club_id, user_id, role) VALUES ($1, $2, 'owner')", [id, userId]);
      return { slug, name, description, createdBy: userId, createdAt: new Date().toISOString(), memberCount: 1 };
    });
  }
  async join(slug: string, userId: string): Promise<void> {
    await withTx(this.pool, async (c) => {
      const club = await c.query<{ id: string }>("SELECT id FROM clubs WHERE slug = $1", [slug]);
      if (!club.rowCount) throw new ClubError("UNKNOWN_CLUB");
      const joined = await c.query<{ n: string }>("SELECT count(*) AS n FROM club_members WHERE user_id = $1", [userId]);
      if (Number(joined.rows[0]!.n) >= CLUB_LIMITS.maxJoined) throw new ClubError("TOO_MANY_CLUBS");
      await c.query("INSERT INTO users (id, username) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING", [userId]);
      const r = await c.query("INSERT INTO club_members (club_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [club.rows[0]!.id, userId]);
      if (!r.rowCount) throw new ClubError("ALREADY_MEMBER");
    });
  }
  async leave(slug: string, userId: string): Promise<void> {
    const r = await this.pool.query<{ role: string }>(
      "SELECT m.role FROM club_members m JOIN clubs c ON c.id = m.club_id WHERE c.slug = $1 AND m.user_id = $2", [slug, userId]);
    if (!r.rowCount) throw new ClubError("NOT_MEMBER");
    if (r.rows[0]!.role === "owner") throw new ClubError("OWNER_CANNOT_LEAVE");
    await this.pool.query("DELETE FROM club_members m USING clubs c WHERE c.id = m.club_id AND c.slug = $1 AND m.user_id = $2", [slug, userId]);
  }
  async isMember(slug: string, userId: string): Promise<boolean> {
    const r = await this.pool.query("SELECT 1 FROM club_members m JOIN clubs c ON c.id = m.club_id WHERE c.slug = $1 AND m.user_id = $2", [slug, userId]);
    return !!r.rowCount;
  }
}

/** Même comportement, en mémoire (serveur sans base, tests). */
export class InMemoryClubStore implements ClubStore {
  private readonly clubs = new Map<string, { name: string; description: string; createdBy: string; createdAt: string; members: Map<string, { role: "owner" | "member"; joinedAt: string }> }>();
  constructor(private readonly ratingOf: (userId: string) => Promise<{ blitz: number; rapid: number; games: number }> = async () => ({ blitz: 1500, rapid: 1500, games: 0 })) {}
  private sum(slug: string): ClubSummary {
    const c = this.clubs.get(slug)!;
    return { slug, name: c.name, description: c.description, createdBy: c.createdBy, createdAt: c.createdAt, memberCount: c.members.size };
  }
  async list(limit: number) { return [...this.clubs.keys()].map((s) => this.sum(s)).sort((a, b) => b.memberCount - a.memberCount).slice(0, limit); }
  async mine(userId: string) { return [...this.clubs.entries()].filter(([, c]) => c.members.has(userId)).map(([s]) => this.sum(s)); }
  async get(slug: string): Promise<ClubDetail | null> {
    const c = this.clubs.get(slug);
    if (!c) return null;
    const members = await Promise.all([...c.members.entries()].map(async ([userId, m]) => ({ userId, role: m.role, joinedAt: m.joinedAt, ...(await this.ratingOf(userId)) })));
    return { ...this.sum(slug), members };
  }
  async create(userId: string, name: string, description: string) {
    if ([...this.clubs.values()].filter((c) => c.createdBy === userId).length >= CLUB_LIMITS.maxOwned) throw new ClubError("TOO_MANY_CLUBS");
    const base = slugify(name);
    let slug = base;
    for (let i = 2; this.clubs.has(slug); i++) slug = `${base}-${i}`;
    const now = new Date().toISOString();
    this.clubs.set(slug, { name, description, createdBy: userId, createdAt: now, members: new Map([[userId, { role: "owner", joinedAt: now }]]) });
    return this.sum(slug);
  }
  async join(slug: string, userId: string) {
    const c = this.clubs.get(slug);
    if (!c) throw new ClubError("UNKNOWN_CLUB");
    if (c.members.has(userId)) throw new ClubError("ALREADY_MEMBER");
    c.members.set(userId, { role: "member", joinedAt: new Date().toISOString() });
  }
  async leave(slug: string, userId: string) {
    const m = this.clubs.get(slug)?.members.get(userId);
    if (!m) throw new ClubError("NOT_MEMBER");
    if (m.role === "owner") throw new ClubError("OWNER_CANNOT_LEAVE");
    this.clubs.get(slug)!.members.delete(userId);
  }
  async isMember(slug: string, userId: string) { return !!this.clubs.get(slug)?.members.has(userId); }
}
