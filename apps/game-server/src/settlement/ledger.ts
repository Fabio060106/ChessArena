import { createHash } from "node:crypto";
import type pg from "pg";
import type { Cents, Currency } from "@chessarena/shared";
import type { SettlementPlan } from "./rake.js";
import { PG, pgCode, withTx, type PgError, type TxOptions } from "../db/tx.js";
import type { AuditSink } from "../audit/auditLog.js";

/**
 * Grand livre en PARTIE DOUBLE (ADR-6).
 *
 * Invariants garantis (et testés) :
 *   I1  chaque lot est équilibré : Σ montants = 0            → aucun jeton créé ni détruit ;
 *   I2  un lot est appliqué au plus une fois (clé d'idempotence) ; rejouer une même clé
 *       avec un contenu différent est une erreur, pas un succès silencieux ;
 *   I3  un lot est atomique : tout ou rien, même si le process meurt en plein milieu ;
 *   I4  étanchéité des devises : un compte porte une seule devise, un lot une seule devise ;
 *   I5  un compte joueur `user:*` n'est jamais négatif.
 *
 * Plan de comptes :
 *   user:<id>:<CUR>          solde disponible du joueur
 *   escrow:<gameId>:<CUR>    mises d'un duel en cours
 *   escrow:t-<tid>:<CUR>     inscriptions d'un tournoi en cours
 *   house:rake:<CUR>         revenu de la plateforme
 *   house:faucet:PLAY        émetteur des jetons PLAY (seul compte PLAY autorisé en négatif)
 *   sponsor:<id>:<CUR>       dotations sponsor/streamer
 */
export interface Posting {
  account: string;
  amountCents: Cents; // > 0 crédit, < 0 débit
}

export type PostResult = { status: "applied" | "duplicate"; transactionId: string };

export interface EscrowContribution {
  account: string;
  netCents: Cents;
}

export interface Ledger {
  post(idempotencyKey: string, currency: Currency, postings: Posting[], meta?: Record<string, unknown>): Promise<PostResult>;
  balance(account: string, currency: Currency): Promise<Cents>;
  /** Comptes escrow au solde non nul (mises encore bloquées). */
  openEscrows(): Promise<Array<{ account: string; currency: Currency; balanceCents: Cents }>>;
  /** Apport net de chaque contrepartie à un escrow (pour rembourser à l'identique). */
  escrowContributions(escrowAccount: string, currency: Currency): Promise<EscrowContribution[]>;
}

// ─── Erreurs typées ──────────────────────────────────────────────────────────
export class LedgerError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}
export class UnbalancedPostingError extends LedgerError {
  constructor(sum: number) { super(`lot déséquilibré (Σ=${sum})`, "UNBALANCED"); }
}
export class InvalidPostingError extends LedgerError {
  constructor(msg: string) { super(msg, "INVALID_POSTING"); }
}
export class CurrencyMismatchError extends LedgerError {
  constructor(account: string, currency: Currency) {
    super(`le compte ${account} n'est pas un compte ${currency}`, "CURRENCY_MISMATCH");
  }
}
export class InsufficientFundsError extends LedgerError {
  constructor(readonly account: string) { super(`solde insuffisant: ${account}`, "INSUFFICIENT_FUNDS"); }
}
/** Sortie d'argent refusée par la base (compte non actif : WITHDRAWAL_HOLD, suspendu…). */
export class PayoutBlockedError extends LedgerError {
  constructor(msg: string) { super(msg, "PAYOUT_BLOCKED"); }
}
/** Entrée d'argent refusée par la base (KYC non vérifié, compte exclu…). */
export class DepositBlockedError extends LedgerError {
  constructor(msg: string) { super(msg, "DEPOSIT_BLOCKED"); }
}
export class IdempotencyConflictError extends LedgerError {
  constructor(readonly key: string) {
    super(`clé d'idempotence ${key} déjà utilisée pour un lot différent`, "IDEMPOTENCY_CONFLICT");
  }
}

// ─── Plan de comptes ─────────────────────────────────────────────────────────
export const acct = {
  user: (id: string, c: Currency) => `user:${id}:${c}`,
  escrow: (gameId: string, c: Currency) => `escrow:${gameId}:${c}`,
  tournamentEscrow: (tid: string, c: Currency) => `escrow:t-${tid}:${c}`,
  rake: (c: Currency) => `house:rake:${c}`,
  faucet: () => "house:faucet:PLAY",
  /** fonds en attente d'un retrait */
  withdrawal: (id: string) => `escrow:wd-${id}:EUR`,
  /** argent sorti vers le prestataire de paiement (garde G1 en base) */
  pspOut: () => "house:psp-out:EUR",
  /** argent entré par dépôt */
  pspIn: () => "house:psp-in:EUR",
  /** fonds confisqués aux tricheurs, en attente de redistribution / décision */
  confiscated: (c: Currency) => `house:confiscated:${c}`,
  /** fonds de garantie fair-play : complète les remboursements de victimes */
  fairplayFund: (c: Currency) => `house:fairplay:${c}`,
};

const ACCOUNT_RE = /^(user|escrow|house|sponsor)(:[^:\s]{1,80})+:(PLAY|EUR)$/;
const CURRENCY_OF = (account: string): Currency | null => {
  const m = account.match(/:(PLAY|EUR)$/);
  return m ? (m[1] as Currency) : null;
};

/** Validation applicative (la base revérifie tout : défense en profondeur). */
export function validatePostings(currency: Currency, postings: Posting[]): void {
  if (postings.length < 2) throw new InvalidPostingError("un lot comporte au moins 2 écritures");
  let sum = 0;
  for (const p of postings) {
    if (!ACCOUNT_RE.test(p.account)) throw new InvalidPostingError(`nom de compte invalide: ${p.account}`);
    if (CURRENCY_OF(p.account) !== currency) throw new CurrencyMismatchError(p.account, currency);
    if (!Number.isSafeInteger(p.amountCents) || p.amountCents === 0) {
      throw new InvalidPostingError(`montant invalide (${p.amountCents}) sur ${p.account}`);
    }
    sum += p.amountCents;
  }
  if (sum !== 0) throw new UnbalancedPostingError(sum);
}

/** Empreinte stable d'un lot (ordre des écritures indifférent). */
export function postingsHash(currency: Currency, postings: Posting[]): string {
  const norm = [...postings].map((p) => `${p.account}|${p.amountCents}`).sort().join(";");
  return createHash("sha256").update(`${currency}#${norm}`).digest("hex");
}

/** Le faucet PLAY est le seul compte autorisé à devenir négatif, et seulement en PLAY. */
const mayGoNegative = (account: string) => !account.startsWith("user:");

// ─── Opérations métier ───────────────────────────────────────────────────────
/** Bloque les mises d'un duel en escrow (un seul lot atomique pour les deux joueurs). */
export function lockStakes(ledger: Ledger, gameId: string, currency: Currency, buyInCents: Cents, players: string[]) {
  return ledger.post(`lock:${gameId}`, currency, players.flatMap((u) => [
    { account: acct.user(u, currency), amountCents: -buyInCents },
    { account: acct.escrow(gameId, currency), amountCents: buyInCents },
  ]), { kind: "lock", gameId, players });
}

/** Vide un escrow vers les gagnants et le rake selon un plan pré-calculé (rake.ts). */
export function applySettlement(ledger: Ledger, escrowId: string, currency: Currency, plan: SettlementPlan, meta: Record<string, unknown> = {}) {
  const postings: Posting[] = [{ account: acct.escrow(escrowId, currency), amountCents: -plan.potCents }];
  for (const [userId, amount] of Object.entries(plan.payouts)) {
    if (amount > 0) postings.push({ account: acct.user(userId, currency), amountCents: amount });
  }
  if (plan.rakeCents > 0) postings.push({ account: acct.rake(currency), amountCents: plan.rakeCents });
  return ledger.post(`settle:${escrowId}`, currency, postings, { kind: "settle", escrowId, ...meta });
}

/**
 * Récupération après crash : rembourse à l'identique tout escrow resté ouvert
 * dont la partie / le tournoi n'est plus actif. Idempotent (clé `orphan-refund:<escrow>`).
 */
export async function refundOrphanedEscrows(
  ledger: Ledger,
  isActive: (escrowAccount: string) => boolean,
): Promise<Array<{ account: string; currency: Currency; refunded: EscrowContribution[] }>> {
  const done: Array<{ account: string; currency: Currency; refunded: EscrowContribution[] }> = [];
  for (const e of await ledger.openEscrows()) {
    if (isActive(e.account)) continue;
    const contributions = (await ledger.escrowContributions(e.account, e.currency)).filter((c) => c.netCents > 0);
    const total = contributions.reduce((a, c) => a + c.netCents, 0);
    if (total !== e.balanceCents) {
      // ne devrait jamais arriver : on ne devine pas, on laisse pour revue humaine
      console.error(`[ledger] escrow ${e.account} : apports ${total} ≠ solde ${e.balanceCents}, remboursement manuel requis`);
      continue;
    }
    await ledger.post(`orphan-refund:${e.account}`, e.currency, [
      { account: e.account, amountCents: -e.balanceCents },
      ...contributions.map((c) => ({ account: c.account, amountCents: c.netCents })),
    ], { kind: "orphan_refund" });
    done.push({ account: e.account, currency: e.currency, refunded: contributions });
  }
  return done;
}

// ═════════════════════════════════════════════════════════════════════════════
// PostgreSQL (production)
// ═════════════════════════════════════════════════════════════════════════════
export type FaultStage = "after_transaction_row" | "after_entries";

/** Contrôle métier exécuté DANS la transaction comptable (jeu responsable, KYC…). */
export type LedgerPolicy = (c: pg.PoolClient, ctx: { key: string; currency: Currency; postings: Posting[]; meta: Record<string, unknown> }) => Promise<void>;

export interface PgLedgerOptions extends TxOptions {
  /** limites de jeu responsable, etc. — une exception annule le lot */
  policy?: LedgerPolicy;
  audit?: AuditSink;
  /** TESTS UNIQUEMENT : simule une panne à une étape précise de la transaction. */
  faultInjector?: (stage: FaultStage, client: pg.PoolClient) => Promise<void> | void;
}

export class PgLedger implements Ledger {
  constructor(private readonly pool: pg.Pool, private readonly opts: PgLedgerOptions = {}) {}

  async post(key: string, currency: Currency, postings: Posting[], meta: Record<string, unknown> = {}): Promise<PostResult> {
    let result: PostResult;
    try {
      result = await withTx(this.pool, (c) => this.postWithin(c, key, currency, postings, meta, false), this.opts);
    } catch (e) {
      throw mapPgError(e, key, currency);
    }
    if (result.status === "applied") this.auditPost(key, currency, result.transactionId, postings, meta);
    return result;
  }

  /**
   * Même opération, DANS une transaction ouverte par l'appelant : permet de lier
   * atomiquement des mouvements d'argent et d'autres écritures (statut d'un retrait,
   * décision de modération…). L'appelant gère COMMIT/ROLLBACK et les reprises ;
   * l'audit est à sa charge après COMMIT (`auditPost`).
   */
  async postWithin(
    c: pg.PoolClient, key: string, currency: Currency, postings: Posting[],
    meta: Record<string, unknown> = {}, mapErrors = true,
  ): Promise<PostResult> {
    validatePostings(currency, postings);
    if (!key || key.length > 200) throw new InvalidPostingError("clé d'idempotence invalide");
    const hash = postingsHash(currency, postings);
    const accounts = [...new Set(postings.map((p) => p.account))];
    try {
      // Comptes créés à la volée (idempotent). Le CHECK de suffixe et la FK
      // (account, currency) empêchent toute fuite entre PLAY et EUR.
      await c.query(
        `INSERT INTO ledger_accounts (account, currency)
         SELECT a, $2::currency FROM unnest($1::text[]) AS a
         ON CONFLICT (account) DO NOTHING`,
        [accounts, currency],
      );
      const ins = await c.query<{ id: string }>(
        `INSERT INTO ledger_transactions (idempotency_key, currency, postings_hash, meta)
         VALUES ($1, $2, $3, $4) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [key, currency, hash, JSON.stringify(meta)],
      );
      if (ins.rowCount === 0) {
        const prev = await c.query<{ id: string; postings_hash: string; currency: Currency }>(
          "SELECT id, postings_hash, currency FROM ledger_transactions WHERE idempotency_key = $1", [key],
        );
        const row = prev.rows[0]!;
        if (row.postings_hash !== hash || row.currency !== currency) throw new IdempotencyConflictError(key);
        return { status: "duplicate", transactionId: row.id };
      }
      const txId = ins.rows[0]!.id;
      // contrôles réglementaires APRÈS le dédoublonnage (un rejeu déjà appliqué n'est pas re-contrôlé)
      // et AVANT toute écriture : l'exception annule la transaction entière
      await this.opts.policy?.(c, { key, currency, postings, meta });
      await this.opts.faultInjector?.("after_transaction_row", c);
      // Une seule requête pour toutes les écritures ; les triggers mettent à jour les
      // soldes (CHECK non-négatif immédiat), filtrent les sorties d'argent (garde
      // retraits) et vérifient l'équilibre au COMMIT.
      await c.query(
        `INSERT INTO ledger_entries (transaction_id, account, currency, amount_cents)
         SELECT $1, a, $3::currency, m FROM unnest($2::text[], $4::bigint[]) AS t(a, m)`,
        [txId, postings.map((p) => p.account), currency, postings.map((p) => p.amountCents)],
      );
      await this.opts.faultInjector?.("after_entries", c);
      return { status: "applied", transactionId: txId };
    } catch (e) {
      throw mapErrors ? mapPgError(e, key, currency) : e;
    }
  }

  auditPost(key: string, currency: Currency, transactionId: string, postings: Posting[], meta: Record<string, unknown>): void {
    this.opts.audit?.append("ledger.post", { key, currency, transactionId, postings, meta });
  }

  async balance(account: string, currency: Currency): Promise<Cents> {
    // comptes maison : pas de cache (cf. migration), lecture par somme des écritures
    const r = account.startsWith("house:")
      ? await this.pool.query<{ b: string }>(
          "SELECT COALESCE(SUM(amount_cents), 0)::bigint AS b FROM ledger_entries WHERE account = $1 AND currency = $2", [account, currency])
      : await this.pool.query<{ b: string }>(
          "SELECT balance_cents AS b FROM ledger_accounts WHERE account = $1 AND currency = $2", [account, currency]);
    return r.rows[0] ? Number(r.rows[0].b) : 0;
  }

  async openEscrows() {
    const r = await this.pool.query<{ account: string; currency: Currency; b: string }>(
      `SELECT account, currency, balance_cents AS b FROM ledger_accounts
        WHERE account LIKE 'escrow:%' AND balance_cents <> 0 ORDER BY account`,
    );
    return r.rows.map((x) => ({ account: x.account, currency: x.currency, balanceCents: Number(x.b) }));
  }

  async escrowContributions(escrowAccount: string, currency: Currency): Promise<EscrowContribution[]> {
    const r = await this.pool.query<{ account: string; net: string }>(
      `SELECT o.account, (-SUM(o.amount_cents))::bigint AS net
         FROM ledger_entries o
        WHERE o.currency = $2
          AND o.account <> $1
          AND o.transaction_id IN (SELECT transaction_id FROM ledger_entries WHERE account = $1 AND currency = $2)
        GROUP BY o.account ORDER BY o.account`,
      [escrowAccount, currency],
    );
    return r.rows.map((x) => ({ account: x.account, netCents: Number(x.net) }));
  }

  /** Contrôle d'intégrité global (tâche quotidienne + tests). */
  async reconcile(): Promise<{
    totals: Record<string, number>;
    cacheMismatches: number;
    unbalancedTransactions: number;
    negativeUsers: number;
  }> {
    const totals = await this.pool.query<{ currency: string; total: string }>(
      "SELECT currency, SUM(amount_cents)::bigint AS total FROM ledger_entries GROUP BY currency",
    );
    const mism = await this.pool.query<{ n: string }>("SELECT count(*) AS n FROM ledger_reconciliation");
    const unb = await this.pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM (SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING SUM(amount_cents) <> 0) x",
    );
    const neg = await this.pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM ledger_accounts WHERE account LIKE 'user:%' AND balance_cents < 0",
    );
    return {
      totals: Object.fromEntries(totals.rows.map((r) => [r.currency, Number(r.total)])),
      cacheMismatches: Number(mism.rows[0]!.n),
      unbalancedTransactions: Number(unb.rows[0]!.n),
      negativeUsers: Number(neg.rows[0]!.n),
    };
  }

  /** Sandbox : crédite des jetons PLAY. JAMAIS d'EUR : aucun chemin de code ne le permet. */
  faucet(userId: string, cents: Cents, nonce: string) {
    return this.post(`faucet:${userId}:${nonce}`, "PLAY", [
      { account: acct.user(userId, "PLAY"), amountCents: cents },
      { account: acct.faucet(), amountCents: -cents },
    ], { kind: "faucet" });
  }
}

function mapPgError(e: unknown, key: string, currency: Currency): unknown {
  if (e instanceof LedgerError) return e;
  const err = e as PgError;
  switch (pgCode(e)) {
    case PG.CHECK_VIOLATION:
      if (err.constraint === "user_balance_non_negative") {
        return new InsufficientFundsError(err.detail?.match(/\(user:[^,]+/)?.[0]?.slice(1) ?? "user:?");
      }
      if (err.constraint === "account_currency_suffix") return new CurrencyMismatchError("?", currency);
      if (err.constraint === "ledger_transaction_balanced") return new UnbalancedPostingError(NaN);
      if (err.constraint === "payout_requires_active_account" || err.constraint === "payout_requires_withdrawal" || err.constraint === "payout_requires_kyc") {
        return new PayoutBlockedError(err.message);
      }
      if (err.constraint?.startsWith("deposit_requires")) return new DepositBlockedError(err.message);
      return e;
    case PG.FOREIGN_KEY_VIOLATION:
      // (account, currency) inconnu dans cette devise : le compte existe dans l'autre
      return new CurrencyMismatchError(err.detail?.match(/\(account, currency\)=\(([^,]+)/)?.[1] ?? "?", currency);
    case PG.UNIQUE_VIOLATION:
      return new LedgerError(`conflit d'unicité inattendu (${key})`, "UNIQUE");
    default:
      return e;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Mémoire (dev sans base, tests unitaires) — mêmes invariants, mêmes erreurs
// ═════════════════════════════════════════════════════════════════════════════
export class InMemoryLedger implements Ledger {
  private entries: Array<Posting & { currency: Currency; key: string }> = [];
  private txs = new Map<string, { id: string; hash: string; currency: Currency }>();
  private balances = new Map<string, Cents>();
  private accountCurrency = new Map<string, Currency>();
  private seq = 0;

  /** Synchrone de bout en bout : aucun entrelacement possible entre contrôle et écriture. */
  async post(key: string, currency: Currency, postings: Posting[]): Promise<PostResult> {
    validatePostings(currency, postings);
    const hash = postingsHash(currency, postings);
    const prev = this.txs.get(key);
    if (prev) {
      if (prev.hash !== hash || prev.currency !== currency) throw new IdempotencyConflictError(key);
      return { status: "duplicate", transactionId: prev.id };
    }
    for (const p of postings) {
      const c = this.accountCurrency.get(p.account);
      if (c && c !== currency) throw new CurrencyMismatchError(p.account, currency);
    }
    const net = new Map<string, Cents>();
    for (const p of postings) net.set(p.account, (net.get(p.account) ?? 0) + p.amountCents);
    for (const [account, delta] of net) {
      if (!mayGoNegative(account) && (this.balances.get(account) ?? 0) + delta < 0) throw new InsufficientFundsError(account);
    }
    const id = `mem-${++this.seq}`;
    this.txs.set(key, { id, hash, currency });
    for (const p of postings) {
      this.accountCurrency.set(p.account, currency);
      this.entries.push({ ...p, currency, key });
      this.balances.set(p.account, (this.balances.get(p.account) ?? 0) + p.amountCents);
    }
    return { status: "applied", transactionId: id };
  }

  async balance(account: string, currency: Currency): Promise<Cents> {
    return this.accountCurrency.get(account) === currency ? (this.balances.get(account) ?? 0) : 0;
  }

  async openEscrows() {
    return [...this.balances]
      .filter(([a, b]) => a.startsWith("escrow:") && b !== 0)
      .map(([account, balanceCents]) => ({ account, currency: this.accountCurrency.get(account)!, balanceCents }));
  }

  async escrowContributions(escrowAccount: string, currency: Currency): Promise<EscrowContribution[]> {
    const keys = new Set(this.entries.filter((e) => e.account === escrowAccount).map((e) => e.key));
    const net = new Map<string, Cents>();
    for (const e of this.entries) {
      if (keys.has(e.key) && e.account !== escrowAccount && e.currency === currency) {
        net.set(e.account, (net.get(e.account) ?? 0) - e.amountCents);
      }
    }
    return [...net].sort().map(([account, netCents]) => ({ account, netCents }));
  }

  /** Rapprochement : la somme de tous les comptes d'une devise doit être nulle. */
  totalOf(currency: Currency): Cents {
    let t = 0;
    for (const e of this.entries) if (e.currency === currency) t += e.amountCents;
    return t;
  }

  /** Sandbox : crédite des jetons PLAY (jamais EUR). */
  faucet(userId: string, cents: Cents, nonce = String(Date.now())) {
    return this.post(`faucet:${userId}:${nonce}`, "PLAY", [
      { account: acct.user(userId, "PLAY"), amountCents: cents },
      { account: acct.faucet(), amountCents: -cents },
    ]);
  }
}
