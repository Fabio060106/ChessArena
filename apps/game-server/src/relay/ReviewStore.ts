import type pg from "pg";

/** Version du format d'analyse pédagogique (le navigateur et le serveur doivent s'accorder). */
export const REVIEW_VERSION = 5;
export const REVIEW_MAX_BYTES = 400_000;

export interface ReviewStore {
  get(key: string): Promise<unknown | null>;
  /** n'écrit que si la clé n'existe pas encore (la première analyse valable est gardée) */
  putIfAbsent(key: string, data: unknown, by: string): Promise<boolean>;
}

export class InMemoryReviewStore implements ReviewStore {
  private readonly m = new Map<string, unknown>();
  async get(key: string) { return this.m.get(key) ?? null; }
  async putIfAbsent(key: string, data: unknown, _by?: string) {
    if (this.m.has(key)) return false;
    if (this.m.size > 2000) this.m.delete(this.m.keys().next().value!);
    this.m.set(key, data);
    return true;
  }
}

export class PgReviewStore implements ReviewStore {
  constructor(private readonly pool: pg.Pool) {}
  async get(key: string) {
    const r = await this.pool.query<{ data: unknown }>("SELECT data FROM relay_reviews WHERE key = $1", [key]);
    return r.rows[0]?.data ?? null;
  }
  async putIfAbsent(key: string, data: unknown, by: string) {
    const r = await this.pool.query("INSERT INTO relay_reviews (key, data, created_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [key, JSON.stringify(data), by]);
    return (r.rowCount ?? 0) > 0;
  }
}

export const reviewStoreKey = (relayId: string, round: number, index: number, plies: number) => `v${REVIEW_VERSION}:${relayId}:${round}:${index}:${plies}`;

/**
 * Vérifie une analyse envoyée par un navigateur : bon format, bonne partie (mêmes coups), taille bornée.
 * Les évaluations elles-mêmes ne sont pas vérifiables sans moteur côté serveur : seule la structure l'est.
 */
export function validReview(review: unknown, sans: readonly string[]): boolean {
  if (!review || typeof review !== "object") return false;
  const r = review as { version?: unknown; moves?: unknown; summary?: unknown };
  if (r.version !== REVIEW_VERSION || typeof r.summary !== "string" || !Array.isArray(r.moves)) return false;
  if (r.moves.length !== sans.length) return false;
  for (let i = 0; i < sans.length; i++) {
    const m = r.moves[i] as { san?: unknown; ply?: unknown } | null;
    if (!m || m.san !== sans[i] || m.ply !== i + 1) return false;
  }
  return JSON.stringify(review).length <= REVIEW_MAX_BYTES;
}
