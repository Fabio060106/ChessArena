import type pg from "pg";

/**
 * Exécution transactionnelle SERIALIZABLE avec reprise automatique.
 *
 * En isolation SERIALIZABLE, PostgreSQL annule une transaction (SQLSTATE 40001)
 * plutôt que d'autoriser une anomalie de concurrence. C'est le comportement voulu
 * pour de l'argent : on préfère rejouer que d'écrire un solde faux. On rejoue aussi
 * sur interblocage (40P01). Le corps `fn` doit donc être rejouable : il ne doit
 * produire AUCUN effet de bord hors base avant le COMMIT.
 */
export const PG = {
  SERIALIZATION_FAILURE: "40001",
  DEADLOCK: "40P01",
  UNIQUE_VIOLATION: "23505",
  FOREIGN_KEY_VIOLATION: "23503",
  CHECK_VIOLATION: "23514",
  RESTRICT_VIOLATION: "23001",
  ADMIN_SHUTDOWN: "57P01",
} as const;

export interface PgError extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
}

export const pgCode = (e: unknown): string | undefined => (e as PgError | undefined)?.code;
export const isRetryable = (e: unknown) => {
  const c = pgCode(e);
  return c === PG.SERIALIZATION_FAILURE || c === PG.DEADLOCK;
};

export class SerializationRetriesExhaustedError extends Error {
  constructor(readonly attempts: number, readonly cause: unknown) {
    super(`transaction abandonnée après ${attempts} tentatives (conflits de sérialisation)`);
  }
}

export interface TxOptions {
  isolation?: "SERIALIZABLE" | "REPEATABLE READ" | "READ COMMITTED";
  maxAttempts?: number;
  /** base du backoff exponentiel avec jitter (ms) */
  backoffMs?: number;
}

export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>, o: TxOptions = {}): Promise<T> {
  const isolation = o.isolation ?? "SERIALIZABLE";
  const maxAttempts = o.maxAttempts ?? 12;
  const backoff = o.backoffMs ?? 5;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = await pool.connect();
    let broken: Error | undefined;
    // Une connexion coupée (backend tué, réseau) émet 'error' sur le client emprunté :
    // sans écouteur, Node ferait tomber le process. On la marque pour destruction.
    const onClientError = (e: Error) => { broken = e; };
    client.on("error", onClientError);
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      lastErr = e;
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        // connexion morte (backend tué, réseau) : on la détruit au lieu de la rendre au pool
        broken = rollbackErr as Error;
      }
      if (!isRetryable(e)) throw e;
    } finally {
      client.off("error", onClientError);
      client.release(broken);
    }
    // backoff exponentiel + jitter : évite que les mêmes transactions se re-percutent
    await new Promise((r) => setTimeout(r, Math.min(backoff * 2 ** (attempt - 1), 250) * (0.5 + Math.random())));
  }
  throw new SerializationRetriesExhaustedError(maxAttempts, lastErr);
}
