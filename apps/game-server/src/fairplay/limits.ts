import type pg from "pg";
import type { AccountComplianceView, Cents, Currency, KycStatus, RgLimitKind, RgLimitView } from "@chessarena/shared";
import { withTx } from "../db/tx.js";
import { LedgerError, type Posting } from "../settlement/ledger.js";
import type { AuditSink } from "../audit/auditLog.js";

/**
 * Jeu responsable — limites et auto-exclusion (règles des opérateurs agréés ANJ).
 *
 *   deposit_week     plafond des DÉPÔTS sur 7 jours glissants — obligatoire AVANT le 1er dépôt
 *   stake_week       plafond des MISES sur 7 jours glissants  — obligatoire AVANT la 1re mise
 *   stake_per_entry  mise maximale par partie / inscription de tournoi (facultatif)
 *
 *   Baisse : effective immédiatement.  Hausse : effective après 48 h (délai de réflexion).
 *   Une hausse en attente est annulée par toute baisse ultérieure.
 *
 *   Auto-exclusion : 24 h à 12 mois, ou définitive (compte clôturé). Irrévocable avant son
 *   terme. Pendant l'exclusion : aucun jeu (PLAY compris), aucun dépôt ; les RETRAITS restent
 *   possibles (le solde appartient au joueur).
 *
 * APPLICATION : `ledgerPolicy` est branchée dans PgLedger et s'exécute DANS la transaction
 * comptable, après verrouillage des lignes de limites du joueur. Aucun dépôt ni aucune mise
 * EUR ne peut contourner les limites, quel que soit l'appelant, et deux opérations
 * concurrentes ne peuvent pas dépasser ensemble un plafond.
 * Les mises sont comptées brutes (une mise remboursée reste comptée) : approche prudente.
 */
/** Exclusion en cours, quel que soit l'état du compte (un joueur en WITHDRAWAL_HOLD peut aussi s'auto-exclure). */
export const EXCLUDED_SQL = "(state IN ('self_excluded', 'closed') OR self_exclusion_permanent OR self_excluded_until > now())";

export const INCREASE_DELAY_MS = 48 * 3600 * 1000;
export const SELF_EXCLUSION_MIN_MS = 24 * 3600 * 1000;
export const SELF_EXCLUSION_MAX_MS = 365 * 24 * 3600 * 1000;
export const WINDOW_MS = 7 * 24 * 3600 * 1000;
const MAX_LIMIT_CENTS = 1_000_000_00; // 1 M€ : borne de saisie

export class ComplianceError extends LedgerError {}
export class LimitExceededError extends ComplianceError {
  constructor(readonly kind: RgLimitKind, readonly limitCents: Cents, readonly usedCents: Cents, readonly attemptedCents: Cents) {
    super(`limite ${kind} dépassée (${usedCents} + ${attemptedCents} > ${limitCents})`, "LIMIT_EXCEEDED");
  }
}
export class LimitsRequiredError extends ComplianceError {
  constructor(readonly kind: RgLimitKind) { super(`limite ${kind} à définir avant toute opération`, "LIMITS_REQUIRED"); }
}
export class SelfExcludedError extends ComplianceError {
  constructor() { super("joueur auto-exclu", "SELF_EXCLUDED"); }
}
export class KycRequiredError extends ComplianceError {
  constructor() { super("vérification d'identité requise", "KYC_REQUIRED"); }
}
export class InvalidLimitError extends ComplianceError {
  constructor(msg: string) { super(msg, "INVALID_LIMIT"); }
}

export interface LimitRow {
  kind: RgLimitKind;
  amount_cents: string;
  pending_amount_cents: string | null;
  pending_effective_at: Date | null;
}

/** Montant en vigueur à l'instant `now` (une hausse arrivée à échéance s'applique). */
export function effectiveLimit(r: LimitRow, now: Date): Cents {
  if (r.pending_amount_cents && r.pending_effective_at && r.pending_effective_at <= now) return Number(r.pending_amount_cents);
  return Number(r.amount_cents);
}

export type LimitChange =
  | { action: "set"; amount: Cents }
  | { action: "decrease"; amount: Cents }
  | { action: "increase_requested"; amount: Cents; effectiveAt: Date }
  | { action: "unchanged" };

/** Politique pure : effet d'une demande de modification. */
export function planLimitChange(current: Cents | null, requested: Cents, now: Date): LimitChange {
  if (current === null) return { action: "set", amount: requested };
  if (requested < current) return { action: "decrease", amount: requested };
  if (requested > current) return { action: "increase_requested", amount: requested, effectiveAt: new Date(now.getTime() + INCREASE_DELAY_MS) };
  return { action: "unchanged" };
}

/** Classification d'un lot comptable : que doit-on contrôler ? (EUR uniquement) */
export interface PolicyContext {
  key: string;
  currency: Currency;
  postings: Posting[];
  meta: Record<string, unknown>;
}

export function classify(ctx: PolicyContext): { deposits: Map<string, Cents>; stakes: Map<string, Cents> } {
  const deposits = new Map<string, Cents>();
  const stakes = new Map<string, Cents>();
  if (ctx.currency !== "EUR") return { deposits, stakes };
  const kind = ctx.meta.kind;
  const userOf = (a: string) => (a.startsWith("user:") ? a.slice(5, a.lastIndexOf(":")) : null);
  if (kind === "deposit") {
    for (const p of ctx.postings) {
      const u = userOf(p.account);
      if (u && p.amountCents > 0) deposits.set(u, (deposits.get(u) ?? 0) + p.amountCents);
    }
  }
  // une mise = débit d'un compte joueur vers un escrow de partie ou de tournoi
  if (kind === "lock" || kind === "tournament_lock") {
    for (const p of ctx.postings) {
      const u = userOf(p.account);
      if (u && p.amountCents < 0) stakes.set(u, (stakes.get(u) ?? 0) - p.amountCents);
    }
  }
  return { deposits, stakes };
}

export class LimitsService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly audit?: AuditSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ─── Lecture ───────────────────────────────────────────────────────────────
  async view(userId: string): Promise<AccountComplianceView> {
    await withTx(this.pool, (c) => this.refreshWithin(c, userId), { isolation: "READ COMMITTED" });
    const u = await this.pool.query<{ kyc: KycStatus; self_excluded_until: Date | null; self_exclusion_permanent: boolean }>(
      "SELECT kyc, self_excluded_until, self_exclusion_permanent FROM users WHERE id = $1", [userId],
    );
    const rows = await this.pool.query<LimitRow>("SELECT * FROM rg_limits WHERE user_id = $1 ORDER BY kind", [userId]);
    const limits: RgLimitView[] = [];
    for (const r of rows.rows) {
      limits.push({
        kind: r.kind,
        amountCents: Number(r.amount_cents),
        pendingAmountCents: r.pending_amount_cents ? Number(r.pending_amount_cents) : null,
        pendingEffectiveAt: r.pending_effective_at?.toISOString() ?? null,
        usedCents: r.kind === "deposit_week" ? await this.used(this.pool, userId, "deposit")
          : r.kind === "stake_week" ? await this.used(this.pool, userId, "stake") : null,
      });
    }
    return {
      kyc: u.rows[0]?.kyc ?? "unverified",
      limits,
      selfExcludedUntil: u.rows[0]?.self_excluded_until?.toISOString() ?? null,
      selfExclusionPermanent: u.rows[0]?.self_exclusion_permanent ?? false,
    };
  }

  /** Cumul des 7 derniers jours (dépôts ou mises EUR). */
  private async used(q: pg.Pool | pg.PoolClient, userId: string, what: "deposit" | "stake"): Promise<Cents> {
    const kinds = what === "deposit" ? ["deposit"] : ["lock", "tournament_lock"];
    const r = await q.query<{ s: string }>(
      `SELECT COALESCE(SUM(${what === "deposit" ? "e.amount_cents" : "-e.amount_cents"}), 0)::bigint AS s
         FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
        WHERE e.account = $1 AND t.meta->>'kind' = ANY($2::text[])
          AND e.created_at > $3 AND ${what === "deposit" ? "e.amount_cents > 0" : "e.amount_cents < 0"}`,
      [`user:${userId}:EUR`, kinds, new Date(this.now().getTime() - WINDOW_MS)],
    );
    return Number(r.rows[0]!.s);
  }

  // ─── Modification des limites ──────────────────────────────────────────────
  async setLimit(userId: string, kind: RgLimitKind, amountCents: Cents): Promise<LimitChange> {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > MAX_LIMIT_CENTS) throw new InvalidLimitError("montant invalide");
    const change = await withTx(this.pool, async (c) => {
      await this.refreshWithin(c, userId);
      const cur = await c.query<LimitRow>("SELECT * FROM rg_limits WHERE user_id = $1 AND kind = $2 FOR UPDATE", [userId, kind]);
      const row = cur.rows[0];
      const now = this.now();
      const plan = planLimitChange(row ? effectiveLimit(row, now) : null, amountCents, now);
      switch (plan.action) {
        case "set":
          await c.query("INSERT INTO rg_limits (user_id, kind, amount_cents) VALUES ($1, $2, $3)", [userId, kind, plan.amount]);
          break;
        case "decrease": // immédiat ; annule toute hausse en attente
          await c.query("UPDATE rg_limits SET amount_cents = $3, pending_amount_cents = NULL, pending_effective_at = NULL, updated_at = now() WHERE user_id = $1 AND kind = $2", [userId, kind, plan.amount]);
          break;
        case "increase_requested":
          await c.query("UPDATE rg_limits SET pending_amount_cents = $3, pending_effective_at = $4, updated_at = now() WHERE user_id = $1 AND kind = $2", [userId, kind, plan.amount, plan.effectiveAt]);
          break;
        case "unchanged":
          await c.query("UPDATE rg_limits SET pending_amount_cents = NULL, pending_effective_at = NULL WHERE user_id = $1 AND kind = $2", [userId, kind]);
          return plan;
      }
      await c.query(
        "INSERT INTO rg_events (user_id, event, kind, old_cents, new_cents, until) VALUES ($1, $2, $3, $4, $5, $6)",
        [userId, plan.action === "set" ? "limit_set" : plan.action === "decrease" ? "limit_decrease" : "limit_increase_requested",
          kind, row ? effectiveLimit(row, now) : null, plan.amount, plan.action === "increase_requested" ? plan.effectiveAt : null],
      );
      return plan;
    });
    if (change.action !== "unchanged") this.audit?.append("compliance.limits", { userId, kind, ...change });
    return change;
  }

  /** Auto-exclusion temporaire (24 h – 12 mois) ou définitive. Irrévocable. */
  async selfExclude(userId: string, opts: { durationMs: number } | { permanent: true }): Promise<{ until: Date | null; permanent: boolean }> {
    const permanent = "permanent" in opts;
    if (!permanent) {
      const d = (opts as { durationMs: number }).durationMs;
      if (!Number.isFinite(d) || d < SELF_EXCLUSION_MIN_MS || d > SELF_EXCLUSION_MAX_MS) throw new InvalidLimitError("durée d'auto-exclusion : 24 h à 12 mois");
    }
    const until = permanent ? null : new Date(this.now().getTime() + (opts as { durationMs: number }).durationMs);
    await withTx(this.pool, async (c) => {
      const u = await c.query<{ state: string; self_excluded_until: Date | null; self_exclusion_permanent: boolean }>(
        "SELECT state, self_excluded_until, self_exclusion_permanent FROM users WHERE id = $1 FOR UPDATE", [userId],
      );
      const row = u.rows[0];
      if (!row) throw new InvalidLimitError("compte inconnu");
      if (row.state === "suspended") throw new InvalidLimitError("compte suspendu");
      // on ne raccourcit jamais une exclusion en cours
      const keepLonger = row.self_exclusion_permanent || (row.self_excluded_until && until && row.self_excluded_until > until);
      if (keepLonger) return;
      await c.query(
        `UPDATE users SET state = CASE WHEN $2 THEN 'closed'::account_state
                                       WHEN state = 'withdrawal_hold' THEN state ELSE 'self_excluded'::account_state END,
                self_excluded_until = $3, self_exclusion_permanent = $2 WHERE id = $1`,
        [userId, permanent, until],
      );
      await c.query("INSERT INTO rg_events (user_id, event, until, details) VALUES ($1, 'self_exclusion', $2, $3)", [userId, until, JSON.stringify({ permanent })]);
    });
    this.audit?.append("compliance.limits", { userId, event: "self_exclusion", until: until?.toISOString() ?? null, permanent });
    return { until, permanent };
  }

  /**
   * Opérations différées, appliquées paresseusement : hausse arrivée à échéance,
   * fin d'auto-exclusion temporaire. Appelée dans toute transaction qui lit les limites.
   */
  async refreshWithin(c: pg.PoolClient, userId: string): Promise<void> {
    const now = this.now();
    const due = await c.query<LimitRow>(
      `UPDATE rg_limits SET amount_cents = pending_amount_cents, pending_amount_cents = NULL, pending_effective_at = NULL, updated_at = now()
        WHERE user_id = $1 AND pending_effective_at <= $2
        RETURNING kind, amount_cents, pending_amount_cents, pending_effective_at`, [userId, now],
    );
    for (const r of due.rows) {
      await c.query("INSERT INTO rg_events (user_id, event, kind, new_cents) VALUES ($1, 'limit_increase_applied', $2, $3)", [userId, r.kind, r.amount_cents]);
    }
    const ended = await c.query(
      `UPDATE users SET state = CASE WHEN state = 'self_excluded' THEN 'active'::account_state ELSE state END, self_excluded_until = NULL
        WHERE id = $1 AND NOT self_exclusion_permanent AND self_excluded_until <= $2 RETURNING id`, [userId, now],
    );
    if ((ended.rowCount ?? 0) > 0) await c.query("INSERT INTO rg_events (user_id, event) VALUES ($1, 'self_exclusion_ended')", [userId]);
  }

  /** Joueur exclu (auto-exclusion en cours ou clôture définitive) ? */
  async isExcluded(userId: string): Promise<boolean> {
    return withTx(this.pool, async (c) => {
      await this.refreshWithin(c, userId);
      const r = await c.query(`SELECT 1 FROM users WHERE id = $1 AND ${EXCLUDED_SQL}`, [userId]);
      return (r.rowCount ?? 0) > 0;
    }, { isolation: "READ COMMITTED" });
  }

  /** Pré-contrôle (UX) avant d'entrer en file / de s'inscrire. Le ledger reste l'autorité. */
  async precheckStake(userId: string, amountCents: Cents): Promise<void> {
    await withTx(this.pool, (c) => this.checkStake(c, userId, amountCents), { isolation: "READ COMMITTED" });
  }

  // ─── Contrôle dans la transaction comptable ────────────────────────────────
  /** À brancher dans PgLedger (`policy`). */
  readonly ledgerPolicy = async (c: pg.PoolClient, ctx: PolicyContext): Promise<void> => {
    const { deposits, stakes } = classify(ctx);
    // ordre déterministe des verrous : pas d'interblocage entre deux joueurs d'une même partie
    for (const u of [...new Set([...deposits.keys(), ...stakes.keys()])].sort()) {
      if (deposits.has(u)) await this.checkDeposit(c, u, deposits.get(u)!);
      if (stakes.has(u)) await this.checkStake(c, u, stakes.get(u)!);
    }
  };

  private async lockLimits(c: pg.PoolClient, userId: string): Promise<Map<RgLimitKind, Cents>> {
    await this.refreshWithin(c, userId);
    const u = await c.query<{ state: string; kyc: KycStatus; excluded: boolean }>(
      `SELECT state, kyc, ${EXCLUDED_SQL} AS excluded FROM users WHERE id = $1 FOR SHARE`, [userId],
    );
    const user = u.rows[0];
    if (!user || user.excluded) throw new SelfExcludedError();
    if (user.state === "suspended") throw new SelfExcludedError();
    if (user.kyc !== "verified") throw new KycRequiredError();
    const rows = await c.query<LimitRow>("SELECT * FROM rg_limits WHERE user_id = $1 ORDER BY kind FOR UPDATE", [userId]);
    const now = this.now();
    return new Map(rows.rows.map((r) => [r.kind, effectiveLimit(r, now)]));
  }

  private async checkDeposit(c: pg.PoolClient, userId: string, amount: Cents): Promise<void> {
    const limits = await this.lockLimits(c, userId);
    const cap = limits.get("deposit_week");
    if (cap === undefined) throw new LimitsRequiredError("deposit_week");
    const used = await this.used(c, userId, "deposit");
    if (used + amount > cap) throw new LimitExceededError("deposit_week", cap, used, amount);
  }

  private async checkStake(c: pg.PoolClient, userId: string, amount: Cents): Promise<void> {
    const limits = await this.lockLimits(c, userId);
    const week = limits.get("stake_week");
    if (week === undefined) throw new LimitsRequiredError("stake_week");
    const perEntry = limits.get("stake_per_entry");
    if (perEntry !== undefined && amount > perEntry) throw new LimitExceededError("stake_per_entry", perEntry, 0, amount);
    const used = await this.used(c, userId, "stake");
    if (used + amount > week) throw new LimitExceededError("stake_week", week, used, amount);
  }
}
