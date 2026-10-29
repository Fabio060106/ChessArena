import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Cents, WithdrawalView } from "@chessarena/shared";
import { withTx } from "../db/tx.js";
import { acct, InsufficientFundsError, LedgerError, type PgLedger } from "./ledger.js";

/**
 * Retraits en argent réel (EUR) et blocage WITHDRAWAL_HOLD.
 *
 *   request()  — le joueur demande un retrait : la somme quitte son solde disponible
 *                pour un escrow dédié `escrow:wd-<id>:EUR` (elle ne peut plus être
 *                misée ni retirée deux fois). Statut `requested`.
 *   process()  — tâche périodique d'exécution. Pour chaque retrait `requested` :
 *                  • titulaire `active`  → escrow → `house:psp-out:EUR`, statut `sent` ;
 *                  • titulaire en WITHDRAWAL_HOLD (ou suspendu…) → statut `on_hold`,
 *                    l'argent reste dans l'escrow. RIEN ne sort.
 *   release()  — levée du blocage par un modérateur : `on_hold` → `requested`.
 *   cancelAllFor() — bannissement : les retraits en attente reviennent sur le solde
 *                (qui sera ensuite traité par la confiscation).
 *
 * DISCRÉTION : le jeu continue normalement pour un joueur sous blocage, et la vue
 * publique d'un retrait retenu est STRICTEMENT identique à celle d'un retrait en cours
 * de traitement (`processing`). Seul le délai diffère, comme pour toute vérification
 * de routine. Les CGU doivent prévoir que les retraits peuvent être suspendus le temps
 * d'une vérification d'équité de jeu (sinon la retenue serait contestable).
 *
 * DÉFENSE EN PROFONDEUR : même si ce service était contourné, la base refuse toute
 * écriture vers `house:psp-out:*` pour un compte non `active` (trigger G1) et tout
 * passage d'un retrait à `sent` (trigger G2). Voir 002_fairplay.sql.
 */
export interface Psp {
  /** envoi au prestataire (sandbox : immédiat). Doit être idempotent par `withdrawalId`. */
  payout(withdrawalId: string, userId: string, amountCents: Cents): Promise<{ pspRef: string }>;
}

export const sandboxPsp: Psp = {
  async payout(withdrawalId) { return { pspRef: `sandbox-${withdrawalId}` }; },
};

export class WithdrawalError extends Error {
  constructor(readonly code: "INVALID_AMOUNT" | "INSUFFICIENT_FUNDS" | "ACCOUNT_CLOSED" | "NOT_FOUND" | "KYC_REQUIRED", msg?: string) {
    super(msg ?? code);
  }
}

/** États dont le titulaire peut être payé (cf. garde-fous G1'/G2' en base). */
export const PAYABLE_STATES = new Set(["active", "self_excluded", "closed"]);

interface Row {
  hold_reason?: string | null;
  id: string;
  user_id: string;
  amount_cents: string;
  status: "requested" | "on_hold" | "sent" | "cancelled";
  created_at: Date;
}

/** Vue PUBLIQUE : `requested` et `on_hold` sont indiscernables. */
export function toPublicView(r: Pick<Row, "id" | "amount_cents" | "status" | "created_at">): WithdrawalView {
  return {
    id: r.id,
    amountCents: Number(r.amount_cents),
    currency: "EUR",
    status: r.status === "sent" ? "sent" : r.status === "cancelled" ? "cancelled" : "processing",
    createdAt: r.created_at.toISOString(),
  };
}

export interface ProcessReport {
  sent: number;
  held: number;
  errors: number;
}

export class WithdrawalService {
  static readonly MIN_CENTS = 1_000; // 10 €

  constructor(private readonly pool: pg.Pool, private readonly ledger: PgLedger, private readonly psp: Psp = sandboxPsp) {}

  async request(userId: string, amountCents: Cents): Promise<WithdrawalView> {
    if (!Number.isSafeInteger(amountCents) || amountCents < WithdrawalService.MIN_CENTS) throw new WithdrawalError("INVALID_AMOUNT");
    const id = randomUUID();
    try {
      const row = await withTx(this.pool, async (c) => {
        const u = await c.query<{ state: string; kyc: string }>("SELECT state, kyc FROM users WHERE id = $1 FOR SHARE", [userId]);
        // Un compte suspendu/fermé ne peut plus rien demander. Un compte en
        // WITHDRAWAL_HOLD, si : la demande est enregistrée comme n'importe quelle autre.
        // Un compte suspendu (triche) ne retire rien. Un compte auto-exclu ou clôturé à sa
        // demande DOIT pouvoir récupérer son solde. Identité vérifiée obligatoire (AML).
        if (!u.rows[0] || u.rows[0].state === "suspended") throw new WithdrawalError("ACCOUNT_CLOSED");
        if (u.rows[0].kyc !== "verified") throw new WithdrawalError("KYC_REQUIRED");
        const ins = await c.query<Row>(
          `INSERT INTO withdrawal_requests (id, user_id, currency, amount_cents, status)
           VALUES ($1, $2, 'EUR', $3, 'requested') RETURNING *`, [id, userId, amountCents],
        );
        await this.ledger.postWithin(c, `wd-reserve:${id}`, "EUR", [
          { account: acct.user(userId, "EUR"), amountCents: -amountCents },
          { account: acct.withdrawal(id), amountCents: amountCents },
        ], { kind: "withdrawal_reserve", withdrawalId: id, userId });
        return ins.rows[0]!;
      });
      return toPublicView(row);
    } catch (e) {
      if (e instanceof InsufficientFundsError) throw new WithdrawalError("INSUFFICIENT_FUNDS");
      throw e;
    }
  }

  async list(userId: string): Promise<WithdrawalView[]> {
    const r = await this.pool.query<Row>("SELECT * FROM withdrawal_requests WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
    return r.rows.map(toPublicView);
  }

  /** Exécute les retraits en attente (appelée par une tâche planifiée). */
  async process(limit = 100): Promise<ProcessReport> {
    const report: ProcessReport = { sent: 0, held: 0, errors: 0 };
    const pending = await this.pool.query<{ id: string }>(
      // + retraits retenus pour un motif levable sans modérateur (KYC à refaire, auto-exclusion…)
      `SELECT id FROM withdrawal_requests
        WHERE status = 'requested' OR (status = 'on_hold' AND hold_reason IN ('kyc_pending', 'kyc_unverified', 'kyc_rejected'))
        ORDER BY created_at LIMIT $1`, [limit],
    );
    for (const { id } of pending.rows) {
      try {
        const outcome = await this.processOne(id);
        if (outcome === "sent") report.sent++;
        else if (outcome === "held") report.held++;
      } catch (e) {
        report.errors++;
        console.error(`[withdrawals] ${id}`, (e as Error).message);
      }
    }
    return report;
  }

  /**
   * Une seule transaction, verrou partagé sur le compte du titulaire : un blocage
   * (UPDATE users) qui arrive pendant l'exécution ATTEND la fin de celle-ci — il n'y a
   * pas de fenêtre où l'argent part alors que le compte vient d'être bloqué.
   * L'appel prestataire est dans la transaction : il doit être idempotent par id de
   * retrait (une reprise après conflit renvoie la même référence, aucun double envoi).
   */
  async processOne(id: string): Promise<"sent" | "held" | "skipped"> {
    try {
      return await withTx(this.pool, async (c) => {
        const w = await c.query<Row>("SELECT * FROM withdrawal_requests WHERE id = $1 FOR UPDATE", [id]);
        const row = w.rows[0];
        if (!row || (row.status !== "requested" && !(row.status === "on_hold" && row.hold_reason?.startsWith("kyc_")))) return "skipped" as const;
        if (row.status === "on_hold") {
          await c.query("UPDATE withdrawal_requests SET status = 'requested', hold_reason = NULL WHERE id = $1", [id]);
          row.status = "requested";
        }
        const u = await c.query<{ state: string; kyc: string }>("SELECT state, kyc FROM users WHERE id = $1 FOR SHARE", [row.user_id]);
        const state = u.rows[0]?.state ?? "unknown";
        if (u.rows[0] && PAYABLE_STATES.has(state) && u.rows[0].kyc !== "verified") {
          await c.query("UPDATE withdrawal_requests SET status = 'on_hold', hold_reason = $2 WHERE id = $1", [id, `kyc_${u.rows[0].kyc}`]);
          return "held" as const;
        }
        if (!PAYABLE_STATES.has(state)) {
          await c.query("UPDATE withdrawal_requests SET status = 'on_hold', hold_reason = $2 WHERE id = $1", [id, `account_${state}`]);
          return "held" as const;
        }
        const amount = Number(row.amount_cents);
        const { pspRef } = await this.psp.payout(row.id, row.user_id, amount);
        await this.ledger.postWithin(c, `payout:${row.id}`, "EUR", [
          { account: acct.withdrawal(row.id), amountCents: -amount },
          { account: acct.pspOut(), amountCents: amount },
        ], { kind: "withdrawal_payout", withdrawalId: row.id, userId: row.user_id, pspRef });
        await c.query("UPDATE withdrawal_requests SET status = 'sent', psp_ref = $2, sent_at = now() WHERE id = $1", [row.id, pspRef]);
        return "sent" as const;
      });
    } catch (e) {
      // Un garde-fou SQL a refusé la sortie d'argent : le retrait est retenu, l'argent reste en escrow.
      if (e instanceof LedgerError || (e as { constraint?: string }).constraint === "withdrawal_requires_active_account") {
        await this.pool.query("UPDATE withdrawal_requests SET status = 'on_hold', hold_reason = 'blocked_by_guard' WHERE id = $1 AND status = 'requested'", [id]);
        return "held";
      }
      throw e;
    }
  }

  /** Levée de blocage : les retraits retenus repartent dans la file d'exécution. */
  async releaseWithin(c: pg.PoolClient, userId: string): Promise<number> {
    const r = await c.query("UPDATE withdrawal_requests SET status = 'requested', hold_reason = NULL WHERE user_id = $1 AND status = 'on_hold'", [userId]);
    return r.rowCount ?? 0;
  }

  /** Bannissement : annule les retraits non envoyés et recrédite le solde du joueur. */
  async cancelAllWithin(c: pg.PoolClient, userId: string, reason: string): Promise<number> {
    const r = await c.query<Row>(
      "SELECT * FROM withdrawal_requests WHERE user_id = $1 AND status IN ('requested', 'on_hold') FOR UPDATE", [userId],
    );
    for (const w of r.rows) {
      await this.ledger.postWithin(c, `wd-cancel:${w.id}`, "EUR", [
        { account: acct.withdrawal(w.id), amountCents: -Number(w.amount_cents) },
        { account: acct.user(userId, "EUR"), amountCents: Number(w.amount_cents) },
      ], { kind: "withdrawal_cancel", withdrawalId: w.id, reason });
      await c.query("UPDATE withdrawal_requests SET status = 'cancelled', hold_reason = $2 WHERE id = $1", [w.id, reason]);
    }
    return r.rows.length;
  }

  async pendingTotal(userId: string): Promise<Cents> {
    const r = await this.pool.query<{ s: string }>(
      "SELECT COALESCE(SUM(amount_cents), 0)::bigint AS s FROM withdrawal_requests WHERE user_id = $1 AND status IN ('requested', 'on_hold')", [userId],
    );
    return Number(r.rows[0]!.s);
  }
}
