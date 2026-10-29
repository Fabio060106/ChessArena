import type { Cents } from "@chessarena/shared";
import { acct, type PgLedger } from "./ledger.js";

/**
 * Dépôts en argent réel (EUR).
 *
 * Le prestataire de paiement confirme un paiement (webhook signé, Sprint 5 pour un PSP
 * réel ; sandbox ici) → `credit()` passe UNE écriture `house:psp-in:EUR → user:<id>:EUR`
 * idempotente par référence PSP. Tous les contrôles réglementaires s'exécutent DANS cette
 * transaction comptable :
 *   • PgLedger.policy (LimitsService) : identité vérifiée, non exclu, limite de dépôts
 *     sur 7 jours définie et respectée ;
 *   • trigger G3 en base : identité vérifiée, compte ouvert (défense en profondeur).
 * Un dépôt refusé n'est jamais crédité : le prestataire doit rembourser le paiement.
 *
 * NB : en production, la limite est contrôlée AVANT d'envoyer le joueur chez le PSP
 * (`precheck`) pour éviter d'encaisser un paiement à rembourser ; le contrôle du ledger
 * reste la seule autorité.
 */
export class DepositError extends Error {
  constructor(readonly code: "INVALID_AMOUNT" | "INVALID_REFERENCE", msg?: string) { super(msg ?? code); }
}

export class DepositService {
  static readonly MIN_CENTS = 5_00;
  static readonly MAX_CENTS = 10_000_00;

  constructor(private readonly ledger: PgLedger) {}

  async credit(userId: string, amountCents: Cents, pspRef: string): Promise<{ status: "applied" | "duplicate"; transactionId: string }> {
    if (!Number.isSafeInteger(amountCents) || amountCents < DepositService.MIN_CENTS || amountCents > DepositService.MAX_CENTS) {
      throw new DepositError("INVALID_AMOUNT");
    }
    if (!/^[\w-]{6,80}$/.test(pspRef)) throw new DepositError("INVALID_REFERENCE");
    return this.ledger.post(`deposit:${pspRef}`, "EUR", [
      { account: acct.pspIn(), amountCents: -amountCents },
      { account: acct.user(userId, "EUR"), amountCents },
    ], { kind: "deposit", userId, pspRef });
  }
}
