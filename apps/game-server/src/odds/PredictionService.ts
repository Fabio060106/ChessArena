import { randomUUID } from "node:crypto";
import type { RelayGameView } from "@chessarena/shared";
import { acct, InsufficientFundsError, type Ledger } from "../settlement/ledger.js";
import type { Bet, BetStore } from "./BetStore.js";
import { BET_LIMITS, humanWdl, marketKey, oddsFromWdl, outcomeOf, payoutOf, PICKS, type Odds, type Pick } from "./odds.js";
import type { Evaluate } from "./wdlEngine.js";

/** Caisse des pronostics : mises en cours (jamais négative). Les gains au-delà de la mise sont émis par le faucet PLAY. */
export const BETS_POOL = "house:bets:PLAY";

export class BetError extends Error {
  constructor(readonly code: "BAD_PAYLOAD" | "NO_MARKET" | "MARKET_CLOSED" | "SUSPENDED" | "ODDS_PENDING" | "ODDS_CHANGED" | "STAKE_LIMIT" | "EXPOSURE_LIMIT" | "INSUFFICIENT") { super(code); }
}

/** Ce que voient les spectateurs d'une partie retransmise. */
export interface MarketView {
  relayId: string;
  round: number;
  index: number;
  /** change à chaque coup et à chaque nouvelle cote : une mise doit citer la version qu'elle a vue */
  version: number;
  ply: number;
  /** null : cotes en cours de calcul (juste après un coup) ou moteur indisponible */
  odds: Odds | null;
  /** probabilités (sans marge) pour la jauge */
  probs: { white: number; draw: number; black: number } | null;
  suspended: boolean;
  closed: boolean;
  result: string | null;
}

interface Market extends MarketView { key: string; fen: string; label: string; pendingFen: string | null }

export interface PredictionDeps {
  ledger: Ledger;
  store: BetStore;
  /** null : pas de moteur (cotes indisponibles, paris fermés) */
  evaluate: Evaluate | null;
  emitOdds(v: MarketView): void;
  notify(userId: string, b: Bet): void;
}

/**
 * Pronostics en jetons sur les parties retransmises (Championnat du monde…) : cotes 1 / N / 2 recalculées
 * par Stockfish après chaque coup, mise à cote figée, règlement automatique au résultat.
 */
export class PredictionService {
  private readonly markets = new Map<string, Market>();
  private queue: string[] = [];
  private working = false;

  constructor(private readonly d: PredictionDeps) {}

  /** Nouvelle position (ou résultat) d'une partie retransmise. */
  async onGame(relayId: string, round: number, g: RelayGameView): Promise<void> {
    const key = marketKey(relayId, round, g.index);
    let m = this.markets.get(key);
    const ply = g.ucis.length;
    if (!m) {
      m = { key, relayId, round, index: g.index, version: 0, ply: -1, odds: null, probs: null, suspended: false, closed: false, result: null,
        fen: g.fen, label: `${g.white.name} – ${g.black.name}`, pendingFen: null };
      this.markets.set(key, m);
    }
    const outcome = outcomeOf(g.result);
    if (outcome) {
      if (!m.closed) { m.closed = true; m.result = g.result; m.version++; this.d.emitOdds(this.view(m)); }
      await this.settle(key, outcome);
      return;
    }
    if (ply === m.ply && m.fen === g.fen) return;
    // nouveau coup : les anciennes cotes ne valent plus rien tant que le moteur n'a pas recalculé
    m.ply = ply; m.fen = g.fen; m.version++; m.odds = null; m.probs = null; m.suspended = false;
    this.d.emitOdds(this.view(m));
    if (!this.d.evaluate) return;
    m.pendingFen = g.fen;
    if (!this.queue.includes(key)) this.queue.push(key);
    void this.pump();
  }

  view(m: Market): MarketView {
    return { relayId: m.relayId, round: m.round, index: m.index, version: m.version, ply: m.ply, odds: m.odds, probs: m.probs, suspended: m.suspended, closed: m.closed, result: m.result };
  }

  /** Cotes connues d'un tournoi retransmis (arrivée d'un spectateur). */
  marketsOf(relayId: string): MarketView[] {
    return [...this.markets.values()].filter((m) => m.relayId === relayId).map((m) => this.view(m));
  }

  private async pump(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length) {
        const key = this.queue.shift()!;
        const m = this.markets.get(key);
        if (!m || m.closed || !m.pendingFen) continue;
        const fen = m.pendingFen;
        m.pendingFen = null;
        const ev = await this.d.evaluate!(fen).catch(() => null);
        if (m.closed || m.fen !== fen) continue; // un coup est arrivé entre-temps : il est déjà en file
        if (!ev) { m.suspended = true; m.version++; this.d.emitOdds(this.view(m)); continue; }
        // cotes « humaines » d'après l'évaluation (le WDL natif du moteur ne sert qu'à défaut)
        const o = oddsFromWdl(ev.cp !== null ? humanWdl(ev.cp) : ev.wdl);
        m.odds = o.odds; m.probs = o.probs; m.suspended = o.suspended; m.version++;
        this.d.emitOdds(this.view(m));
      }
    } finally {
      this.working = false;
    }
  }

  async place(userId: string, p: { relayId: string; round: number; index: number; pick: Pick; stakeCents: number; version: number }): Promise<{ bet: Bet; balanceCents: number }> {
    if (!PICKS.includes(p.pick) || !Number.isSafeInteger(p.stakeCents) || !Number.isSafeInteger(p.version)) throw new BetError("BAD_PAYLOAD");
    if (p.stakeCents < BET_LIMITS.minCents || p.stakeCents > BET_LIMITS.maxCents || p.stakeCents % 100 !== 0) throw new BetError("STAKE_LIMIT");
    const m = this.markets.get(marketKey(p.relayId, p.round, p.index));
    if (!m) throw new BetError("NO_MARKET");
    if (m.closed) throw new BetError("MARKET_CLOSED");
    if (!m.odds) throw new BetError("ODDS_PENDING");
    if (m.suspended) throw new BetError("SUSPENDED");
    if (m.version !== p.version) throw new BetError("ODDS_CHANGED");
    const open = (await this.d.store.openFor(m.key)).filter((b) => b.userId === userId).reduce((s, b) => s + b.stakeCents, 0);
    if (open + p.stakeCents > BET_LIMITS.maxOpenPerMarketCents) throw new BetError("EXPOSURE_LIMIT");
    const odds = m.odds[p.pick];
    const bet: Bet = {
      id: randomUUID(), userId, market: m.key, relayId: m.relayId, pick: p.pick, stakeCents: p.stakeCents, odds, ply: m.ply,
      label: `${m.label}${m.round ? `, ronde ${m.round}` : ""}`, status: "open", payoutCents: 0, createdAt: new Date().toISOString(), settledAt: null,
    };
    try {
      await this.d.ledger.post(`bet:${bet.id}`, "PLAY", [
        { account: acct.user(userId, "PLAY"), amountCents: -p.stakeCents },
        { account: BETS_POOL, amountCents: p.stakeCents },
      ], { kind: "bet_place", market: m.key, pick: p.pick, odds });
    } catch (e) {
      if (e instanceof InsufficientFundsError) throw new BetError("INSUFFICIENT");
      throw e;
    }
    try {
      await this.d.store.insert(bet);
    } catch (e) {
      // pari non enregistré : la mise est rendue
      await this.d.ledger.post(`bet-undo:${bet.id}`, "PLAY", [
        { account: BETS_POOL, amountCents: -p.stakeCents },
        { account: acct.user(userId, "PLAY"), amountCents: p.stakeCents },
      ], { kind: "bet_undo" });
      throw e;
    }
    return { bet, balanceCents: await this.d.ledger.balance(acct.user(userId, "PLAY"), "PLAY") };
  }

  /** Règle les paris ouverts d'une partie terminée (idempotent : un pari n'est payé qu'une fois). */
  async settle(key: string, outcome: Pick | "void"): Promise<number> {
    let n = 0;
    for (const b of await this.d.store.openFor(key)) {
      const won = outcome !== "void" && b.pick === outcome;
      const status: Bet["status"] = outcome === "void" ? "void" : won ? "won" : "lost";
      const payout = outcome === "void" ? b.stakeCents : won ? payoutOf(b.stakeCents, b.odds) : 0;
      const postings = outcome === "void"
        ? [{ account: BETS_POOL, amountCents: -b.stakeCents }, { account: acct.user(b.userId, "PLAY"), amountCents: b.stakeCents }]
        : won
          ? [{ account: BETS_POOL, amountCents: -b.stakeCents }, { account: acct.faucet(), amountCents: -(payout - b.stakeCents) }, { account: acct.user(b.userId, "PLAY"), amountCents: payout }]
          : [{ account: BETS_POOL, amountCents: -b.stakeCents }, { account: acct.faucet(), amountCents: b.stakeCents }];
      await this.d.ledger.post(`betpay:${b.id}`, "PLAY", postings, { kind: "bet_settle", market: key, status });
      if (await this.d.store.settle(b.id, status, payout)) {
        n++;
        this.d.notify(b.userId, { ...b, status, payoutCents: payout, settledAt: new Date().toISOString() });
      }
    }
    return n;
  }

  async mine(userId: string): Promise<{ bets: Bet[]; balanceCents: number }> {
    return { bets: await this.d.store.forUser(userId, 30), balanceCents: await this.d.ledger.balance(acct.user(userId, "PLAY"), "PLAY") };
  }
}
