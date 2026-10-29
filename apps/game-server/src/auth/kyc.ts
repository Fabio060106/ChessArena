import { createHmac, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import type { KycStatus } from "@chessarena/shared";
import { withTx } from "../db/tx.js";
import type { AuditSink } from "../audit/auditLog.js";

/**
 * Vérification d'identité (KYC) et filtrage AML.
 *
 *   UNVERIFIED ──start()──▶ PENDING ──décision prestataire──▶ VERIFIED
 *                              │                              │
 *                              └──────────▶ REJECTED ◀────────┘ (révocation conformité)
 *   REJECTED ──start()──▶ PENDING     (nouvelle tentative, MAX_ATTEMPTS au total)
 *   VERIFIED ──requireReverification()──▶ PENDING   (pièce expirée, alerte AML…)
 *
 * Règles de décision (appliquées ICI, pas seulement chez le prestataire) :
 *   • âge < 18 ans à la date du contrôle            → REJECTED (MINOR), définitif ;
 *   • correspondance sanctions / gel des avoirs      → PENDING + revue humaine obligatoire ;
 *   • personne politiquement exposée (PEP)           → PENDING + revue humaine (vigilance renforcée) ;
 *   • document refusé par le prestataire             → REJECTED (motif du prestataire).
 * Une revue humaine tranche via `review()`, journalisée avec l'identifiant de l'agent.
 *
 * DONNÉES : aucune pièce d'identité ni image n'est stockée ici (minimisation RGPD) :
 * seulement la référence du dossier chez le prestataire, la date de naissance, le pays
 * de résidence vérifié et un résumé des contrôles.
 */
export const KYC_TRANSITIONS: Record<KycStatus, KycStatus[]> = {
  unverified: ["pending"],
  pending: ["verified", "rejected"],
  verified: ["pending", "rejected"],
  rejected: ["pending"],
};

export const MAX_KYC_ATTEMPTS = 3;
export const ADULT_AGE = 18;

export class KycError extends Error {
  constructor(readonly code: "INVALID_TRANSITION" | "TOO_MANY_ATTEMPTS" | "MINOR_LOCKED" | "UNKNOWN_USER" | "BAD_SIGNATURE" | "STALE_WEBHOOK" | "BAD_PAYLOAD", msg?: string) {
    super(msg ?? code);
  }
}

export function assertTransition(from: KycStatus, to: KycStatus): void {
  if (!KYC_TRANSITIONS[from].includes(to)) throw new KycError("INVALID_TRANSITION", `${from} → ${to}`);
}

/** Âge révolu à une date donnée (anniversaire inclus). */
export function ageOn(birthDate: string, on: Date): number {
  const [y, m, d] = birthDate.split("-").map(Number) as [number, number, number];
  let age = on.getUTCFullYear() - y;
  const md = (on.getUTCMonth() + 1) * 100 + on.getUTCDate();
  if (md < m * 100 + d) age--;
  return age;
}

/** Résultat transmis par le prestataire (webhook). */
export interface ProviderResult {
  eventId: string;
  userId: string;
  providerRef: string;
  document: "approved" | "declined";
  declineReason?: string;
  /** AAAA-MM-JJ lue sur la pièce */
  birthDate?: string;
  /** pays de résidence vérifié (ISO-3166 alpha-2) */
  country?: string;
  sanctionsHit?: boolean;
  pepHit?: boolean;
}

export interface KycDecision {
  to: KycStatus;
  reason: string | null;
  reviewRequired: boolean;
}

/** Politique pure (testée isolément). */
export function decide(r: ProviderResult, now: Date): KycDecision {
  if (r.document === "declined") return { to: "rejected", reason: r.declineReason ?? "DOCUMENT_DECLINED", reviewRequired: false };
  if (!r.birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(r.birthDate) || !r.country || !/^[A-Z]{2}$/.test(r.country)) {
    return { to: "rejected", reason: "INCOMPLETE_DATA", reviewRequired: false };
  }
  if (ageOn(r.birthDate, now) < ADULT_AGE) return { to: "rejected", reason: "MINOR", reviewRequired: false };
  if (r.sanctionsHit) return { to: "pending", reason: "SANCTIONS_HIT", reviewRequired: true };
  if (r.pepHit) return { to: "pending", reason: "PEP_HIT", reviewRequired: true };
  return { to: "verified", reason: null, reviewRequired: false };
}

// ─── Webhook signé (OWASP : authenticité, fraîcheur, anti-rejeu) ─────────────
/** En-tête `x-kyc-signature: t=<unix>,v1=<hex hmac-sha256(secret, "t.body")>` */
export function signWebhook(secret: string, rawBody: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}

export function verifyWebhook(secret: string, rawBody: string, header: string | undefined, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)): void {
  if (!secret) throw new KycError("BAD_SIGNATURE", "secret webhook non configuré");
  const parts = Object.fromEntries((header ?? "").split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || !/^[0-9a-f]{64}$/.test(parts.v1)) throw new KycError("BAD_SIGNATURE");
  if (Math.abs(nowSec - t) > toleranceSec) throw new KycError("STALE_WEBHOOK");
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const got = Buffer.from(parts.v1, "hex");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new KycError("BAD_SIGNATURE");
}

/** Prestataire KYC (Onfido, Sumsub, Ubble…). Sandbox fournie pour le développement. */
export interface KycProvider {
  readonly name: string;
  /** crée un dossier et retourne l'URL du parcours de capture à ouvrir côté joueur */
  createSession(userId: string): Promise<{ providerRef: string; url: string }>;
}

export const sandboxKycProvider: KycProvider = {
  name: "sandbox",
  async createSession(userId) {
    const ref = `sbx_${userId}_${Date.now().toString(36)}`;
    return { providerRef: ref, url: `https://kyc.sandbox.invalid/session/${ref}` };
  },
};

export interface KycState {
  status: KycStatus;
  attempts: number;
  reviewRequired: boolean;
  country: string | null;
}

export class KycService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly provider: KycProvider = sandboxKycProvider,
    private readonly audit?: AuditSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async state(userId: string): Promise<KycState> {
    const r = await this.pool.query<{ kyc: KycStatus; kyc_attempts: number; kyc_review_required: boolean; country: string | null }>(
      "SELECT kyc, kyc_attempts, kyc_review_required, country FROM users WHERE id = $1", [userId],
    );
    const u = r.rows[0];
    if (!u) throw new KycError("UNKNOWN_USER");
    return { status: u.kyc, attempts: u.kyc_attempts, reviewRequired: u.kyc_review_required, country: u.country };
  }

  async isVerified(userId: string): Promise<boolean> {
    const r = await this.pool.query("SELECT 1 FROM users WHERE id = $1 AND kyc = 'verified'", [userId]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Le joueur lance (ou relance) la vérification. */
  async start(userId: string): Promise<{ status: KycStatus; url: string }> {
    const session = await this.provider.createSession(userId);
    await withTx(this.pool, async (c) => {
      const u = await c.query<{ kyc: KycStatus; kyc_attempts: number; last_reason: string | null }>(
        `SELECT u.kyc, u.kyc_attempts,
                (SELECT reason FROM kyc_events e WHERE e.user_id = u.id ORDER BY id DESC LIMIT 1) AS last_reason
           FROM users u WHERE u.id = $1 FOR UPDATE`, [userId],
      );
      const row = u.rows[0];
      if (!row) throw new KycError("UNKNOWN_USER");
      if (row.kyc === "rejected" && row.last_reason === "MINOR") throw new KycError("MINOR_LOCKED");
      if (row.kyc_attempts >= MAX_KYC_ATTEMPTS) throw new KycError("TOO_MANY_ATTEMPTS");
      assertTransition(row.kyc, "pending");
      await c.query("UPDATE users SET kyc = 'pending', kyc_attempts = kyc_attempts + 1 WHERE id = $1", [userId]);
      await c.query(
        "INSERT INTO kyc_events (user_id, from_status, to_status, actor, provider, provider_ref) VALUES ($1, $2, 'pending', 'user', $3, $4)",
        [userId, row.kyc, this.provider.name, session.providerRef],
      );
    });
    this.audit?.append("compliance.kyc", { userId, to: "pending", provider: this.provider.name, providerRef: session.providerRef });
    return { status: "pending", url: session.url };
  }

  /** Décision du prestataire (webhook déjà authentifié). Idempotent par `eventId`. */
  async applyProviderResult(r: ProviderResult): Promise<KycDecision & { duplicate: boolean }> {
    const d = decide(r, this.now());
    const out = await withTx(this.pool, async (c) => {
      const dup = await c.query("SELECT 1 FROM kyc_events WHERE provider_event_id = $1", [r.eventId]);
      if ((dup.rowCount ?? 0) > 0) return { ...d, duplicate: true };
      const u = await c.query<{ kyc: KycStatus }>("SELECT kyc FROM users WHERE id = $1 FOR UPDATE", [r.userId]);
      const from = u.rows[0]?.kyc;
      if (!from) throw new KycError("UNKNOWN_USER");
      if (from !== "pending") throw new KycError("INVALID_TRANSITION", `résultat reçu hors état pending (${from})`);
      if (d.to !== "pending") assertTransition(from, d.to);
      await c.query(
        `UPDATE users SET kyc = $2::kyc_status, kyc_review_required = $3,
                birth_date = COALESCE($4::date, birth_date), country = COALESCE($5, country),
                kyc_verified_at = CASE WHEN $2::kyc_status = 'verified' THEN now() ELSE kyc_verified_at END
          WHERE id = $1`,
        [r.userId, d.to, d.reviewRequired, d.to === "rejected" && d.reason !== "MINOR" ? null : r.birthDate ?? null, d.to === "verified" ? r.country : null],
      );
      await c.query(
        `INSERT INTO kyc_events (user_id, from_status, to_status, actor, provider, provider_ref, provider_event_id, reason, checks)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [r.userId, from, d.to, `provider:${this.provider.name}`, this.provider.name, r.providerRef, r.eventId, d.reason,
          JSON.stringify({ document: r.document, adult: r.birthDate ? ageOn(r.birthDate, this.now()) >= ADULT_AGE : null, country: r.country ?? null, sanctionsHit: !!r.sanctionsHit, pepHit: !!r.pepHit })],
      );
      return { ...d, duplicate: false };
    });
    if (!out.duplicate) this.audit?.append("compliance.kyc", { userId: r.userId, to: out.to, reason: out.reason, reviewRequired: out.reviewRequired, providerRef: r.providerRef });
    return out;
  }

  /** Revue humaine (agent conformité) d'un dossier en alerte AML. */
  async review(userId: string, agentId: string, approve: boolean, note: string): Promise<KycStatus> {
    if (note.trim().length < 5) throw new KycError("BAD_PAYLOAD", "motif obligatoire");
    const to: KycStatus = approve ? "verified" : "rejected";
    await withTx(this.pool, async (c) => {
      const u = await c.query<{ kyc: KycStatus; kyc_review_required: boolean; country: string | null }>(
        "SELECT kyc, kyc_review_required, country FROM users WHERE id = $1 FOR UPDATE", [userId],
      );
      const row = u.rows[0];
      if (!row) throw new KycError("UNKNOWN_USER");
      assertTransition(row.kyc, to);
      await c.query(
        "UPDATE users SET kyc = $2::kyc_status, kyc_review_required = false, kyc_verified_at = CASE WHEN $2::kyc_status = 'verified' THEN now() ELSE kyc_verified_at END WHERE id = $1",
        [userId, to],
      );
      await c.query(
        "INSERT INTO kyc_events (user_id, from_status, to_status, actor, reason, checks) VALUES ($1, $2, $3, $4, $5, $6)",
        [userId, row.kyc, to, agentId, approve ? "MANUAL_APPROVAL" : "MANUAL_REJECTION", JSON.stringify({ note: note.trim() })],
      );
    });
    this.audit?.append("compliance.kyc", { userId, to, agentId, manual: true });
    return to;
  }

  /** Repasse un compte vérifié en PENDING (pièce expirée, alerte AML, changement de pays…). */
  async requireReverification(userId: string, agentId: string, reason: string): Promise<void> {
    await withTx(this.pool, async (c) => {
      const u = await c.query<{ kyc: KycStatus }>("SELECT kyc FROM users WHERE id = $1 FOR UPDATE", [userId]);
      const from = u.rows[0]?.kyc;
      if (!from) throw new KycError("UNKNOWN_USER");
      assertTransition(from, "pending");
      await c.query("UPDATE users SET kyc = 'pending', kyc_review_required = true WHERE id = $1", [userId]);
      await c.query("INSERT INTO kyc_events (user_id, from_status, to_status, actor, reason) VALUES ($1, $2, 'pending', $3, $4)", [userId, from, agentId, reason]);
    });
    this.audit?.append("compliance.kyc", { userId, to: "pending", agentId, reason });
  }

  /** Validation du corps du webhook (entrée non fiable). */
  static parseWebhook(body: unknown): ProviderResult {
    const b = body as Record<string, unknown>;
    const str = (k: string, max = 128) => (typeof b?.[k] === "string" && (b[k] as string).length <= max ? (b[k] as string) : undefined);
    const r: ProviderResult = {
      eventId: str("eventId") ?? "",
      userId: str("userId", 64) ?? "",
      providerRef: str("providerRef") ?? "",
      document: b?.document === "approved" ? "approved" : b?.document === "declined" ? "declined" : (undefined as never),
      declineReason: str("declineReason", 64),
      birthDate: str("birthDate", 10),
      country: str("country", 2),
      sanctionsHit: b?.sanctionsHit === true,
      pepHit: b?.pepHit === true,
    };
    if (!r.eventId || !r.userId || !r.providerRef || !r.document) throw new KycError("BAD_PAYLOAD");
    return r;
  }
}
