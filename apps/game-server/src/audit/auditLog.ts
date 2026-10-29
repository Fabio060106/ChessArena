import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import type pg from "pg";
import { withTx } from "../db/tx.js";

/**
 * Journal d'audit inaltérable par CHAÎNAGE DE HASH SHA-256.
 *
 *     hash(n) = SHA-256( canonical({ seq, ts, type, payload, prevHash: hash(n-1) }) )
 *     hash(0) = "000…0" (genèse)
 *
 * Modifier, supprimer, insérer ou réordonner une entrée casse la chaîne à partir de
 * ce point : `verifyChain()` le détecte et indique la première séquence fautive.
 *
 * Deux implémentations derrière la même interface :
 *  - FileAuditLog : dev sans base (fichier JSONL) ;
 *  - PgAuditLog   : production. Écritures BUFFERISÉES (hors du chemin chaud des coups),
 *    vidées par lots dans une transaction qui verrouille `audit_head` : la chaîne reste
 *    linéaire même avec plusieurs instances du game-server.
 */
export type AuditType = "game.move" | "game.end" | "ledger.post" | "tournament.event" | "anticheat.flag" | "account.hold" | "moderation.decision"
  | "compliance.kyc" | "compliance.limits" | "compliance.killswitch" | "regulatory.export";

export interface AuditEntry {
  seq: number;
  ts: string; // ISO-8601, précision milliseconde
  type: AuditType;
  payload: unknown;
  prevHash: string;
  hash: string;
}

export interface AuditSink {
  /** Non bloquant : n'attend jamais d'I/O (appelé depuis le chemin chaud). */
  append(type: AuditType, payload: unknown): void;
  /** Attend que tout ce qui a été `append` soit durablement écrit. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

export const GENESIS_HASH = "0".repeat(64);

export function hashEntry(base: Omit<AuditEntry, "hash">): string {
  return createHash("sha256").update(canonical(base)).digest("hex");
}

/** JSON à clés triées : le même objet donne toujours le même hash (et survit au JSONB). */
export function canonical(v: unknown): string {
  if (v === null || v === undefined || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

/**
 * Normalise un payload comme le ferait un aller-retour JSON / JSONB (suppression des
 * `undefined`, Date → ISO…). On hache la forme normalisée pour que la vérification
 * depuis la base retrouve exactement les mêmes octets.
 */
function normalize(payload: unknown): unknown {
  return JSON.parse(JSON.stringify(payload ?? null));
}

export type VerifyResult =
  | { ok: true; checked: number; headHash: string }
  | { ok: false; checked: number; brokenAt: number; reason: string };

/** Vérifie une suite d'entrées (ordre croissant), à partir d'un point de départ connu. */
export function verifyChain(entries: AuditEntry[], from: { seq: number; hash: string } = { seq: 0, hash: GENESIS_HASH }): VerifyResult {
  let prev = from.hash;
  let expectedSeq = from.seq + 1;
  for (const e of entries) {
    if (e.seq !== expectedSeq) return { ok: false, checked: expectedSeq - from.seq - 1, brokenAt: expectedSeq, reason: `séquence manquante ou dupliquée (trouvé ${e.seq})` };
    if (e.prevHash !== prev) return { ok: false, checked: expectedSeq - from.seq - 1, brokenAt: e.seq, reason: "prev_hash ne correspond pas à l'entrée précédente" };
    const { hash, ...base } = e;
    if (hashEntry(base) !== hash) return { ok: false, checked: expectedSeq - from.seq - 1, brokenAt: e.seq, reason: "contenu modifié (hash recalculé différent)" };
    prev = hash;
    expectedSeq++;
  }
  return { ok: true, checked: expectedSeq - from.seq - 1, headHash: prev };
}

// ═════════════════════════════════════════════════════════════════════════════
// Fichier (dev)
// ═════════════════════════════════════════════════════════════════════════════
export class FileAuditLog implements AuditSink {
  private seq = 0;
  private lastHash = GENESIS_HASH;
  private stream: WriteStream | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  append(type: AuditType, payload: unknown): void {
    const base = { seq: ++this.seq, ts: new Date().toISOString(), type, payload: normalize(payload), prevHash: this.lastHash };
    const entry: AuditEntry = { ...base, hash: hashEntry(base) };
    this.lastHash = entry.hash;
    const s = this.open();
    this.pending = this.pending.then(() => new Promise<void>((res) => s.write(JSON.stringify(entry) + "\n", () => res())));
  }

  get head() {
    return { seq: this.seq, hash: this.lastHash };
  }

  flush(): Promise<void> {
    return this.pending;
  }

  async close(): Promise<void> {
    await this.pending;
    const s = this.stream;
    this.stream = null;
    if (s) await new Promise<void>((r) => s.end(r));
  }

  private open(): WriteStream {
    if (!this.stream) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.stream = createWriteStream(this.filePath, { flags: "a" });
      this.stream.on("error", (e) => console.error("[audit] écriture impossible", e));
    }
    return this.stream;
  }
}

/** @deprecated nom du Sprint 1, conservé pour compatibilité */
export { FileAuditLog as HashChainAuditLog };

// ═════════════════════════════════════════════════════════════════════════════
// PostgreSQL (production)
// ═════════════════════════════════════════════════════════════════════════════
interface Pending { ts: string; type: AuditType; payload: unknown }

export interface PgAuditOptions {
  /** délai max avant écriture d'un lot (ms) */
  flushIntervalMs?: number;
  /** taille max d'un lot */
  batchSize?: number;
}

export class PgAuditLog implements AuditSink {
  private buffer: Pending[] = [];
  private flushing: Promise<void> | null = null; // lot en cours d'écriture
  private timer: ReturnType<typeof setInterval>;
  private readonly batchSize: number;
  failures = 0;

  constructor(private readonly pool: pg.Pool, o: PgAuditOptions = {}) {
    this.batchSize = o.batchSize ?? 500;
    this.timer = setInterval(() => void this.flush().catch(() => {}), o.flushIntervalMs ?? 50);
    this.timer.unref();
  }

  append(type: AuditType, payload: unknown): void {
    // horodatage à l'événement (pas à l'écriture) ; normalisé en ms comme TIMESTAMPTZ le restitue
    this.buffer.push({ ts: new Date().toISOString(), type, payload: normalize(payload) });
    if (this.buffer.length >= this.batchSize) void this.flush().catch(() => {});
  }

  /**
   * Vide le tampon. Les lots sont écrits strictement l'un après l'autre ; la promesse
   * ne se résout que lorsque le tampon est vide ET qu'aucun lot n'est en vol.
   * Plusieurs appels concurrents (minuterie, close) se coordonnent via `flushing`.
   */
  async flush(): Promise<void> {
    for (;;) {
      if (this.flushing) {
        await this.flushing; // relance l'erreur éventuelle à l'appelant
        continue;
      }
      if (this.buffer.length === 0) return;
      const batch = this.buffer.splice(0, this.batchSize);
      this.flushing = this.writeBatch(batch)
        .catch((e) => {
          // Échec : on remet le lot EN TÊTE pour préserver l'ordre, et on réessaiera.
          this.failures++;
          if (this.failures === 1 || this.failures % 100 === 0) console.error("[audit] écriture du lot échouée, nouvel essai", e);
          this.buffer.unshift(...batch);
          throw e;
        })
        .finally(() => { this.flushing = null; });
    }
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  private async writeBatch(batch: Pending[]): Promise<void> {
    await withTx(this.pool, async (c) => {
      // Verrou de la tête de chaîne : un seul écrivain à la fois, toutes instances confondues.
      const head = await c.query<{ seq: string; hash: string }>("SELECT seq, hash FROM audit_head WHERE id FOR UPDATE");
      let seq = Number(head.rows[0]!.seq);
      let prevHash = head.rows[0]!.hash;
      const rows: AuditEntry[] = [];
      for (const p of batch) {
        const base = { seq: ++seq, ts: p.ts, type: p.type, payload: p.payload, prevHash };
        const hash = hashEntry(base);
        rows.push({ ...base, hash });
        prevHash = hash;
      }
      await c.query(
        `INSERT INTO audit_log (seq, ts, type, payload, prev_hash, hash)
         SELECT * FROM unnest($1::bigint[], $2::timestamptz[], $3::text[], $4::jsonb[], $5::text[], $6::text[])`,
        [rows.map((r) => r.seq), rows.map((r) => r.ts), rows.map((r) => r.type),
          rows.map((r) => JSON.stringify(r.payload)), rows.map((r) => r.prevHash), rows.map((r) => r.hash)],
      );
      await c.query("UPDATE audit_head SET seq = $1, hash = $2 WHERE id", [seq, prevHash]);
    }, { isolation: "READ COMMITTED" }); // le FOR UPDATE suffit à sérialiser
  }
}

/**
 * Vérifie l'intégrité de la table `audit_log` par pages (mémoire constante),
 * puis compare la fin de chaîne à `audit_head`. Un DELETE en fin de table (non
 * détectable par la chaîne seule) est ainsi détecté par la tête.
 */
export async function verifyAuditTable(pool: pg.Pool, pageSize = 5_000): Promise<VerifyResult> {
  let from = { seq: 0, hash: GENESIS_HASH };
  let checked = 0;
  for (;;) {
    const r = await pool.query<{ seq: string; ts: Date; type: AuditType; payload: unknown; prev_hash: string; hash: string }>(
      "SELECT seq, ts, type, payload, prev_hash, hash FROM audit_log WHERE seq > $1 ORDER BY seq LIMIT $2",
      [from.seq, pageSize],
    );
    if (r.rows.length === 0) break;
    const entries: AuditEntry[] = r.rows.map((x) => ({
      seq: Number(x.seq), ts: x.ts.toISOString(), type: x.type, payload: x.payload, prevHash: x.prev_hash, hash: x.hash,
    }));
    const v = verifyChain(entries, from);
    if (!v.ok) return { ...v, checked: checked + v.checked };
    checked += v.checked;
    from = { seq: entries.at(-1)!.seq, hash: v.headHash };
  }
  const head = await pool.query<{ seq: string; hash: string }>("SELECT seq, hash FROM audit_head WHERE id");
  const h = head.rows[0]!;
  if (Number(h.seq) !== from.seq || h.hash !== from.hash) {
    return { ok: false, checked, brokenAt: from.seq + 1, reason: `fin de chaîne (${from.seq}) ≠ tête enregistrée (${h.seq}) : entrées supprimées` };
  }
  return { ok: true, checked, headHash: from.hash };
}

/** Puits vide (tests unitaires). */
export class NullAuditLog implements AuditSink {
  readonly entries: Array<{ type: AuditType; payload: unknown }> = [];
  append(type: AuditType, payload: unknown): void { this.entries.push({ type, payload }); }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}
