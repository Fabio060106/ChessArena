/**
 * Export réglementaire signé.
 *
 * Produit, pour une période [from, to), un paquet vérifiable hors ligne par un régulateur
 * ou un auditeur, sans accès à nos systèmes :
 *
 *   deposits.{json,csv}      dépôts crédités (lot comptable `kind=deposit`)
 *   withdrawals.{json,csv}   demandes de retrait (statut interne réel, motif de blocage inclus)
 *   rake.{json,csv}          commission prélevée (écritures du compte house:rake:EUR)
 *   kyc.{json,csv}           transitions KYC (journal immuable kyc_events)
 *   rg.{json,csv}            limites de jeu, auto-exclusions (journal immuable rg_events)
 *   fairplay.{json,csv}      remboursements et confiscations fair-play
 *   compliance.{json,csv}    bascules du kill-switch argent réel
 *   manifest.json            empreintes SHA-256 de chaque fichier, totaux, tête de la
 *                            chaîne d'audit, contrôle d'équilibre du grand livre
 *   manifest.sig             signature Ed25519 du manifeste (base64)
 *   public_key.pem           clé publique (son empreinte figure dans le manifeste)
 *
 * Intégrité : modifier un seul octet d'un fichier change son SHA-256, qui ne correspond
 * plus au manifeste ; modifier le manifeste invalide la signature. La clé publique doit
 * être communiquée au régulateur par un autre canal (son empreinte est publiée), sinon un
 * faussaire pourrait re-signer avec sa propre clé.
 *
 * CSV : protection contre l'injection de formules (OWASP « CSV Injection ») — toute
 * cellule texte commençant par = + - @ TAB ou CR est préfixée d'une apostrophe.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import type { AuditSink } from "./auditLog.js";
import { verifyAuditTable } from "./auditLog.js";

export const EXPORT_FORMAT = "chessarena-regulatory-export/1";
export const MAX_PERIOD_DAYS = 366;

type Cell = string | number | boolean | null;
type Row = Record<string, Cell>;

interface SectionDef {
  name: string;
  columns: string[];
  sql: string;
  /** colonne sommée dans les totaux (centimes) */
  sum?: string;
}

const SECTIONS: SectionDef[] = [
  {
    name: "deposits",
    columns: ["transaction_id", "created_at", "user_id", "amount_cents", "currency", "psp_ref", "idempotency_key"],
    sum: "amount_cents",
    sql: `SELECT t.id AS transaction_id, t.created_at, t.meta->>'userId' AS user_id, e.amount_cents, t.currency::text AS currency,
                 t.meta->>'pspRef' AS psp_ref, t.idempotency_key
            FROM ledger_transactions t
            JOIN ledger_entries e ON e.transaction_id = t.id AND e.account LIKE 'user:%'
           WHERE t.meta->>'kind' = 'deposit' AND t.created_at >= $1 AND t.created_at < $2
           ORDER BY t.created_at, t.id`,
  },
  {
    name: "withdrawals",
    columns: ["withdrawal_id", "user_id", "amount_cents", "currency", "status", "hold_reason", "psp_ref", "created_at", "sent_at"],
    sum: "amount_cents",
    sql: `SELECT id AS withdrawal_id, user_id, amount_cents, currency::text AS currency, status, hold_reason, psp_ref, created_at, sent_at
            FROM withdrawal_requests
           WHERE (created_at >= $1 AND created_at < $2) OR (sent_at >= $1 AND sent_at < $2)
           ORDER BY created_at, id`,
  },
  {
    name: "rake",
    columns: ["transaction_id", "created_at", "amount_cents", "kind", "game_id", "tournament_id"],
    sum: "amount_cents",
    sql: `SELECT t.id AS transaction_id, e.created_at, e.amount_cents, t.meta->>'kind' AS kind,
                 t.meta->>'gameId' AS game_id, t.meta->>'tournamentId' AS tournament_id
            FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
           WHERE e.account = 'house:rake:EUR' AND e.created_at >= $1 AND e.created_at < $2
           ORDER BY e.created_at, e.id`,
  },
  {
    name: "kyc",
    columns: ["event_id", "created_at", "user_id", "from_status", "to_status", "actor", "provider", "provider_ref", "reason", "checks"],
    sql: `SELECT id AS event_id, created_at, user_id, from_status::text, to_status::text, actor, provider, provider_ref, reason, checks::text AS checks
            FROM kyc_events WHERE created_at >= $1 AND created_at < $2 ORDER BY id`,
  },
  {
    name: "rg",
    columns: ["event_id", "created_at", "user_id", "event", "kind", "old_cents", "new_cents", "until", "details"],
    sql: `SELECT id AS event_id, created_at, user_id, event, kind::text, old_cents, new_cents, until, details::text AS details
            FROM rg_events WHERE created_at >= $1 AND created_at < $2 ORDER BY id`,
  },
  {
    name: "fairplay",
    columns: ["transaction_id", "created_at", "kind", "account", "amount_cents", "currency", "case_id"],
    sql: `SELECT t.id AS transaction_id, e.created_at, t.meta->>'kind' AS kind, e.account, e.amount_cents, t.currency::text AS currency,
                 t.meta->>'caseId' AS case_id
            FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id
           WHERE t.meta->>'kind' IN ('fairplay_refund', 'fairplay_confiscation') AND t.currency = 'EUR'
             AND t.created_at >= $1 AND t.created_at < $2
           ORDER BY t.created_at, e.id`,
  },
  {
    name: "compliance",
    columns: ["event_id", "created_at", "event", "actor", "details"],
    sql: `SELECT id AS event_id, created_at, event, actor, details::text AS details
            FROM compliance_events WHERE created_at >= $1 AND created_at < $2 ORDER BY id`,
  },
];

// ═════════════════════════════════════════════════════════════════════════════
// Sérialisation déterministe
// ═════════════════════════════════════════════════════════════════════════════
/** JSON canonique : clés triées, pas d'espaces — mêmes données ⇒ mêmes octets. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

/** Cellule CSV RFC 4180 + neutralisation des formules (OWASP). */
export function csvCell(v: Cell): string {
  if (v === null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n']/.test(s) || s !== v ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Row[]): string {
  return [columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c] ?? null)).join(","))].join("\r\n") + "\r\n";
}

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

function normalizeRow(columns: string[], raw: Record<string, unknown>): Row {
  const out: Row = {};
  for (const c of columns) {
    const v = raw[c];
    if (v === null || v === undefined) out[c] = null;
    else if (v instanceof Date) out[c] = v.toISOString();
    else if (typeof v === "number" || typeof v === "boolean") out[c] = v;
    // BIGINT arrive en texte depuis pg : les montants restent des entiers exacts
    else if (typeof v === "string" && /_cents$/.test(c) && /^-?\d+$/.test(v)) out[c] = Number(v);
    else out[c] = String(v);
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// Types du paquet
// ═════════════════════════════════════════════════════════════════════════════
export interface ManifestFile { name: string; sha256: string; bytes: number; rows: number }

export interface Manifest {
  format: typeof EXPORT_FORMAT;
  exportId: string;
  period: { from: string; to: string };
  generatedAt: string;
  generatedBy: string;
  files: ManifestFile[];
  totals: Record<string, { rows: number; sumCents?: number }>;
  auditChain: { headSeq: number; headHash: string; verified: boolean; reason?: string };
  ledger: { eurBalanced: boolean; unbalancedTransactions: number };
  signature: { algorithm: "Ed25519"; keyFingerprint: string; ephemeralKey: boolean };
}

export interface ExportBundle {
  manifest: Manifest;
  /** octets exacts signés (= manifest.json) */
  manifestJson: string;
  signatureB64: string;
  publicKeyPem: string;
  files: Record<string, string>;
}

export interface ExporterOptions {
  /** clé privée Ed25519 PEM (PKCS#8). Vide : clé éphémère en dev, REFUS en production. */
  signingKeyPem: string;
  production: boolean;
  now?: () => Date;
}

export class ExportError extends Error {
  constructor(readonly code: "BAD_PERIOD" | "PERIOD_TOO_LONG" | "NO_SIGNING_KEY" | "BAD_KEY") { super(code); }
}

export function keyFingerprint(publicKeyPem: string): string {
  return sha256(createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }));
}

// ═════════════════════════════════════════════════════════════════════════════
export class RegulatoryExporter {
  private key: { priv: KeyObject; pubPem: string; ephemeral: boolean } | null = null;
  private readonly now: () => Date;

  constructor(private readonly pool: pg.Pool, private readonly audit: AuditSink | undefined, private readonly o: ExporterOptions) {
    this.now = o.now ?? (() => new Date());
  }

  private signingKey() {
    if (this.key) return this.key;
    if (!this.o.signingKeyPem) {
      if (this.o.production) throw new ExportError("NO_SIGNING_KEY");
      const kp = generateKeyPairSync("ed25519");
      this.key = { priv: kp.privateKey, pubPem: kp.publicKey.export({ type: "spki", format: "pem" }).toString(), ephemeral: true };
      return this.key;
    }
    let priv: KeyObject;
    try {
      priv = createPrivateKey(this.o.signingKeyPem);
    } catch {
      throw new ExportError("BAD_KEY");
    }
    if (priv.asymmetricKeyType !== "ed25519") throw new ExportError("BAD_KEY");
    this.key = { priv, pubPem: createPublicKey(priv).export({ type: "spki", format: "pem" }).toString(), ephemeral: false };
    return this.key;
  }

  get publicKeyPem(): string { return this.signingKey().pubPem; }

  async generate(from: Date, to: Date, generatedBy: string): Promise<ExportBundle> {
    if (!(from instanceof Date) || !(to instanceof Date) || Number.isNaN(+from) || Number.isNaN(+to) || to <= from) throw new ExportError("BAD_PERIOD");
    if (+to - +from > MAX_PERIOD_DAYS * 86_400_000) throw new ExportError("PERIOD_TOO_LONG");
    const key = this.signingKey();

    const files: Record<string, string> = {};
    const totals: Manifest["totals"] = {};
    const fileMeta: ManifestFile[] = [];

    // Toutes les sections lues dans UNE transaction REPEATABLE READ : instantané cohérent
    const c = await this.pool.connect();
    let head: { seq: string; hash: string };
    let unbalanced: number;
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      for (const s of SECTIONS) {
        const r = await c.query(s.sql, [from, to]);
        const rows = r.rows.map((x) => normalizeRow(s.columns, x));
        const json = canonicalJson({ section: s.name, period: { from: from.toISOString(), to: to.toISOString() }, columns: s.columns, rows }) + "\n";
        const csv = toCsv(s.columns, rows);
        files[`${s.name}.json`] = json;
        files[`${s.name}.csv`] = csv;
        const t: { rows: number; sumCents?: number } = { rows: rows.length };
        if (s.sum) t.sumCents = rows.reduce((a, x) => a + (typeof x[s.sum!] === "number" ? (x[s.sum!] as number) : 0), 0);
        totals[s.name] = t;
        for (const [name, body] of [[`${s.name}.json`, json], [`${s.name}.csv`, csv]] as const) {
          fileMeta.push({ name, sha256: sha256(body), bytes: Buffer.byteLength(body), rows: rows.length });
        }
      }
      head = (await c.query<{ seq: string; hash: string }>("SELECT seq, hash FROM audit_head")).rows[0]!;
      unbalanced = Number((await c.query<{ n: string }>(
        "SELECT count(*) AS n FROM (SELECT transaction_id FROM ledger_entries WHERE currency = 'EUR' GROUP BY transaction_id HAVING SUM(amount_cents) <> 0) x",
      )).rows[0]!.n);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
    const chain = await verifyAuditTable(this.pool);

    const manifest: Manifest = {
      format: EXPORT_FORMAT,
      exportId: randomUUID(),
      period: { from: from.toISOString(), to: to.toISOString() },
      generatedAt: this.now().toISOString(),
      generatedBy,
      files: fileMeta,
      totals,
      auditChain: { headSeq: Number(head.seq), headHash: head.hash, verified: chain.ok, ...(chain.ok ? {} : { reason: chain.reason }) },
      ledger: { eurBalanced: unbalanced === 0, unbalancedTransactions: unbalanced },
      signature: { algorithm: "Ed25519", keyFingerprint: keyFingerprint(key.pubPem), ephemeralKey: key.ephemeral },
    };
    const manifestJson = canonicalJson(manifest);
    const signatureB64 = sign(null, Buffer.from(manifestJson), key.priv).toString("base64");

    await this.pool.query(
      "INSERT INTO regulatory_exports (id, period_from, period_to, manifest_sha256, key_fingerprint, generated_by) VALUES ($1, $2, $3, $4, $5, $6)",
      [manifest.exportId, from, to, sha256(manifestJson), manifest.signature.keyFingerprint, generatedBy],
    );
    this.audit?.append("regulatory.export", {
      exportId: manifest.exportId, period: manifest.period, manifestSha256: sha256(manifestJson),
      keyFingerprint: manifest.signature.keyFingerprint, generatedBy,
    });
    return { manifest, manifestJson, signatureB64, publicKeyPem: key.pubPem, files };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Vérification (indépendante de la base : utilisable par l'auditeur)
// ═════════════════════════════════════════════════════════════════════════════
export interface VerifyExportResult { ok: boolean; errors: string[] }

/**
 * @param trustedFingerprint empreinte SHA-256 (SPKI DER) de la clé publique reçue du
 *        régulateur par un canal séparé. Sans elle, on prouve seulement la cohérence interne.
 */
export function verifyExport(
  b: Pick<ExportBundle, "manifestJson" | "signatureB64" | "publicKeyPem" | "files">,
  trustedFingerprint?: string,
): VerifyExportResult {
  const errors: string[] = [];
  let manifest: Manifest;
  try {
    manifest = JSON.parse(b.manifestJson) as Manifest;
  } catch {
    return { ok: false, errors: ["manifeste illisible"] };
  }
  let sigOk = false;
  try {
    sigOk = verify(null, Buffer.from(b.manifestJson), createPublicKey(b.publicKeyPem), Buffer.from(b.signatureB64, "base64"));
  } catch { /* clé ou signature mal formée */ }
  if (!sigOk) errors.push("signature du manifeste invalide");
  const fp = (() => { try { return keyFingerprint(b.publicKeyPem); } catch { return ""; } })();
  if (fp !== manifest.signature?.keyFingerprint) errors.push("empreinte de clé différente de celle du manifeste");
  if (trustedFingerprint && fp !== trustedFingerprint) errors.push("clé de signature non reconnue");
  if (manifest.format !== EXPORT_FORMAT) errors.push(`format inconnu : ${manifest.format}`);
  const listed = new Set<string>();
  for (const f of manifest.files ?? []) {
    listed.add(f.name);
    const body = b.files[f.name];
    if (body === undefined) errors.push(`fichier manquant : ${f.name}`);
    else if (sha256(body) !== f.sha256) errors.push(`empreinte invalide : ${f.name}`);
  }
  for (const name of Object.keys(b.files)) if (!listed.has(name)) errors.push(`fichier non déclaré : ${name}`);
  return { ok: errors.length === 0, errors };
}

/** Écrit le paquet dans un répertoire (CLI, archivage WORM). */
export async function writeExportDir(b: ExportBundle, dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const out: Array<[string, string]> = [
    ...Object.entries(b.files),
    ["manifest.json", b.manifestJson],
    ["manifest.sig", b.signatureB64 + "\n"],
    ["public_key.pem", b.publicKeyPem],
  ];
  for (const [name, body] of out) {
    if (!/^[a-z_]+\.(json|csv|sig|pem)$/.test(name)) throw new Error(`nom de fichier refusé : ${name}`);
    await writeFile(join(dir, name), body, { flag: "wx" });   // jamais d'écrasement
  }
  return out.map(([n]) => n);
}
