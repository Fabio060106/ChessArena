import type { Cents } from "@chessarena/shared";

/**
 * Calcul du rake et des gains — fonctions PURES, entièrement testées.
 * Règles :
 *  - tout en centimes entiers ;
 *  - rake = floor(pot × bps / 10 000) ; l'arrondi profite au joueur, jamais à la maison ;
 *  - Σ payouts + rake === pot (invariant vérifié, sinon exception → rien n'est écrit).
 */
export interface SettlementPlan {
  potCents: Cents;
  rakeCents: Cents;
  payouts: Record<string, Cents>;
}

export function computeRake(potCents: Cents, rakeBps: number): Cents {
  assertCents(potCents);
  if (!Number.isInteger(rakeBps) || rakeBps < 0 || rakeBps > 10_000) {
    throw new Error(`rakeBps invalide: ${rakeBps}`);
  }
  return Math.floor((potCents * rakeBps) / 10_000);
}

/**
 * Duel 1v1.
 *  - victoire : le gagnant prend pot − rake
 *  - nulle    : chacun récupère sa mise moins la moitié du rake (centime résiduel → joueur blanc)
 *  - annulée  : remboursement intégral, rake = 0 (partie non jouée)
 */
export function settleDuel(
  buyInCents: Cents,
  white: string,
  black: string,
  outcome: "white" | "black" | "draw" | "aborted",
  rakeBps: number,
): SettlementPlan {
  assertCents(buyInCents);
  const pot = buyInCents * 2;
  if (outcome === "aborted") {
    return check({ potCents: pot, rakeCents: 0, payouts: { [white]: buyInCents, [black]: buyInCents } });
  }
  const rake = computeRake(pot, rakeBps);
  const net = pot - rake;
  if (outcome === "draw") {
    const half = Math.floor(net / 2);
    return check({ potCents: pot, rakeCents: rake, payouts: { [white]: net - half, [black]: half } });
  }
  const winner = outcome === "white" ? white : black;
  const loser = outcome === "white" ? black : white;
  return check({ potCents: pot, rakeCents: rake, payouts: { [winner]: net, [loser]: 0 } });
}

/**
 * Tournoi (Sit & Go, Swiss, Arena) : pot = buy-in × nb inscrits (+ éventuelle dotation
 * sponsor, NON soumise au rake). Répartition par pourcentages en bps sur le net.
 * Le reliquat d'arrondi va au 1er.
 */
export function settleTournament(
  buyInCents: Cents,
  entrants: number,
  ranking: string[],
  structureBps: number[],
  rakeBps: number,
  sponsorAddedCents: Cents = 0,
): SettlementPlan {
  assertCents(buyInCents);
  assertCents(sponsorAddedCents);
  const sum = structureBps.reduce((a, b) => a + b, 0);
  if (sum !== 10_000) throw new Error(`structure de gains ≠ 100 % (${sum} bps)`);
  if (ranking.length < structureBps.length) throw new Error("classement plus court que la structure de gains");
  const entryPot = buyInCents * entrants;
  const rake = computeRake(entryPot, rakeBps);
  const net = entryPot - rake + sponsorAddedCents;
  const payouts: Record<string, Cents> = {};
  let distributed = 0;
  structureBps.forEach((bps, i) => {
    const amount = Math.floor((net * bps) / 10_000);
    payouts[ranking[i]!] = amount;
    distributed += amount;
  });
  payouts[ranking[0]!] = (payouts[ranking[0]!] ?? 0) + (net - distributed);
  return check({ potCents: entryPot + sponsorAddedCents, rakeCents: rake, payouts });
}

/**
 * Structures de gains par défaut des Sit & Go : 65 % / 35 % de la cagnotte nette
 * (après rake) au vainqueur et au finaliste, quel que soit le nombre de joueurs.
 * Modifiable par format de table (`payoutBps`).
 */
export const SIT_AND_GO_STRUCTURES: Record<4 | 6 | 8, number[]> = {
  4: [6_500, 3_500],
  6: [6_500, 3_500],
  8: [6_500, 3_500],
};

function check(plan: SettlementPlan): SettlementPlan {
  const total = Object.values(plan.payouts).reduce((a, b) => a + b, 0) + plan.rakeCents;
  if (total !== plan.potCents) {
    throw new Error(`INVARIANT VIOLÉ: payouts+rake=${total} ≠ pot=${plan.potCents}`);
  }
  for (const v of Object.values(plan.payouts)) assertCents(v);
  return plan;
}

function assertCents(v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`montant invalide (centimes entiers ≥ 0 attendus): ${v}`);
}
