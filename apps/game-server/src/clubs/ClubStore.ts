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
  /** le fondateur modifie la description */
  describe(slug: string, userId: string, description: string): Promise<void>;
  /** organisateur du site : suppression (contenu inapproprié) */
  remove(slug: string): Promise<boolean>;
  /** annonces : publiées et retirées par le fondateur */
  post(slug: string, userId: string, body: string): Promise<void>;
  unpost(slug: string, userId: string, id: string): Promise<void>;
}

export function cleanPost(raw: unknown): string {
  const b = typeof raw === "string" ? raw.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() : "";
  if (!b.length || b.length > 500 || /[<>]/.test(b)) throw new ClubError("BAD_DESCRIPTION");
  return b;
}

interface Row { slug: string; name: string; description: string; created_by: string; created_at: Date; member_count: string | number; avg_blitz?: string | number | null; battles_won?: string | number | null }
const summary = (r: Row): ClubSummary => ({
  slug: r.slug, name: r.name, description: r.description, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString(), memberCount: Number(r.member_count),
  avgBlitz: Math.round(Number(r.avg_blitz ?? 1500)), battlesWon: Number(r.battles_won ?? 0),
});
const SELECT = `SELECT c.slug, c.name, c.description, c.created_by, c.created_at,
  (SELECT count(*) FROM club_members m WHERE m.club_id = c.id) AS member_count,
  (SELECT avg(coalesce(r.rating, 1500)) FROM club_members m LEFT JOIN ratings r ON r.user_id = m.user_id AND r.time_control = 'blitz_3_0' WHERE m.club_id = c.id) AS avg_blitz,
  (SELECT count(*) FROM tournaments t WHERE t.status = 'finished' AND t.snapshot->'teamBattle'->'teams'->0->>'slug' = c.slug) AS battles_won
  FROM clubs c`;

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
    const posts = await this.pool.query<{ id: string; author: string; body: string; created_at: Date }>(
      "SELECT id, author, body, created_at FROM club_posts WHERE club_id = $1 ORDER BY created_at DESC, id DESC LIMIT 10", [row.id]);
    return { ...summary(row), members, posts: posts.rows.map((p) => ({ id: String(p.id), author: p.author, body: p.body, createdAt: new Date(p.created_at).toISOString() })) };
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
  async describe(slug: string, userId: string, description: string): Promise<void> {
    const r = await this.pool.query("UPDATE clubs SET description = $3 WHERE slug = $1 AND created_by = $2", [slug, userId, description]);
    if (!r.rowCount) throw new ClubError("NOT_MEMBER");
  }
  async remove(slug: string): Promise<boolean> {
    return !!(await this.pool.query("DELETE FROM clubs WHERE slug = $1", [slug])).rowCount; // membres supprimés en cascade
  }
  async post(slug: string, userId: string, body: string): Promise<void> {
    const r = await this.pool.query(
      "INSERT INTO club_posts (club_id, author, body) SELECT id, $2, $3 FROM clubs WHERE slug = $1 AND created_by = $2", [slug, userId, body]);
    if (!r.rowCount) throw new ClubError("NOT_MEMBER");
    // on ne garde que les 30 dernières annonces
    await this.pool.query(`DELETE FROM club_posts WHERE club_id = (SELECT id FROM clubs WHERE slug = $1)
      AND id NOT IN (SELECT id FROM club_posts WHERE club_id = (SELECT id FROM clubs WHERE slug = $1) ORDER BY created_at DESC, id DESC LIMIT 30)`, [slug]);
  }
  async unpost(slug: string, userId: string, id: string): Promise<void> {
    if (!/^\d{1,18}$/.test(id)) throw new ClubError("NOT_MEMBER");
    const r = await this.pool.query("DELETE FROM club_posts p USING clubs c WHERE c.id = p.club_id AND c.slug = $1 AND c.created_by = $2 AND p.id = $3", [slug, userId, id]);
    if (!r.rowCount) throw new ClubError("NOT_MEMBER");
  }
}

/** Même comportement, en mémoire (serveur sans base, tests). */
export class InMemoryClubStore implements ClubStore {
  private readonly clubs = new Map<string, { name: string; description: string; createdBy: string; createdAt: string; members: Map<string, { role: "owner" | "member"; joinedAt: string }>; posts: Array<{ id: string; author: string; body: string; createdAt: string }> }>();
  private postSeq = 0;
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
    return { ...this.sum(slug), members, posts: [...c.posts].reverse().slice(0, 10) };
  }
  async create(userId: string, name: string, description: string) {
    if ([...this.clubs.values()].filter((c) => c.createdBy === userId).length >= CLUB_LIMITS.maxOwned) throw new ClubError("TOO_MANY_CLUBS");
    const base = slugify(name);
    let slug = base;
    for (let i = 2; this.clubs.has(slug); i++) slug = `${base}-${i}`;
    const now = new Date().toISOString();
    this.clubs.set(slug, { name, description, createdBy: userId, createdAt: now, members: new Map([[userId, { role: "owner", joinedAt: now }]]), posts: [] });
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
  async describe(slug: string, userId: string, description: string) {
    const c = this.clubs.get(slug);
    if (!c || c.createdBy !== userId) throw new ClubError("NOT_MEMBER");
    c.description = description;
  }
  async remove(slug: string) { return this.clubs.delete(slug); }
  async post(slug: string, userId: string, body: string) {
    const c = this.clubs.get(slug);
    if (!c || c.createdBy !== userId) throw new ClubError("NOT_MEMBER");
    c.posts.push({ id: String(++this.postSeq), author: userId, body, createdAt: new Date().toISOString() });
  }
  async unpost(slug: string, userId: string, id: string) {
    const c = this.clubs.get(slug);
    if (!c || c.createdBy !== userId || !c.posts.some((p) => p.id === id)) throw new ClubError("NOT_MEMBER");
    c.posts = c.posts.filter((p) => p.id !== id);
  }
}
