import { randomUUID } from "node:crypto";
import type {
  Color, Cents, Currency, SngGameKind, SngGameView, SngMatchView, SngPlayerView, SngSize, SngSnapshot, TimeControlId,
} from "@chessarena/shared";
import type { FinishedGame, Seat, TournamentGameRef } from "../game/GameRoom.js";
import { acct, applySettlement, InsufficientFundsError, type Ledger } from "../settlement/ledger.js";
import { computeRake, settleTournament } from "../settlement/rake.js";
import type { AuditSink } from "../audit/auditLog.js";

/**
 * Moteur de tournoi Sit & Go — élimination directe (KO), 4, 6 ou 8 joueurs.
 *
 * Cycle de vie :
 *   registering ──(table pleine)──▶ running ──(finale jouée)──▶ finished
 *        └──(annulation)──▶ cancelled (remboursement intégral, sans rake)
 *
 * ARGENT
 *   • Inscription = 1 lot atomique `tlock:<tid>:<uid>:<n>` : user → escrow du tournoi.
 *     La place n'est acquise qu'APRÈS le COMMIT (statut `locking` → `registered`).
 *   • Désinscription (avant le départ) = lot `tunreg:<tid>:<uid>:<n>` en sens inverse.
 *   • Fin = lot unique `settle:t-<tid>` : escrow → vainqueur / finaliste / rake.
 *     Rake = 10 % des inscriptions ; la dotation sponsor n'est pas rakée.
 *   • Annulation = lot `tcancel:<tid>` qui rend à chacun son apport net exact.
 *
 * TABLEAU
 *   • Têtes de série par Elo (départage : ordre d'inscription), placement standard
 *     1-8, 4-5, 2-7, 3-6 : les deux meilleurs ne peuvent se croiser qu'en finale.
 *   • À 6 joueurs, tableau de 8 : les têtes de série 1 et 2 sont exemptes au 1er tour.
 *   • Un tour suivant ne démarre que lorsque tous les matchs du tour sont terminés.
 *
 * DÉPARTAGE D'UN MATCH (tie-breakers)
 *   1. partie principale (couleurs tirées au sort) ;
 *   2. si nulle : revanche, couleurs inversées ;
 *   3. si nulle : Armageddon — la tête de série la mieux classée a les Noirs et la
 *      nulle lui suffit (récompense du classement, décision déterministe et
 *      annoncée à l'avance). Partie non classée Elo.
 *   Partie annulée (1er coup non joué, abandon/départ avant 2 demi-coups) : perdue
 *   par le responsable (`abortedBy`). Sans responsable identifiable : rejouée.
 */
export interface SitAndGoConfig {
  id: string;
  formatId: string;
  size: SngSize;
  timeControl: TimeControlId;
  currency: Currency;
  buyInCents: Cents;
  rakeBps: number;
  payoutBps: number[];
  sponsorAddedCents?: Cents;
}

export interface StartGameRequest {
  /** id attribué par le moteur AVANT la création : un résultat ne peut pas arriver « orphelin » */
  gameId: string;
  white: Seat;
  black: Seat;
  timeControl: TimeControlId;
  currency: Currency;
  rated: boolean;
  tournament: TournamentGameRef;
}

export interface SitAndGoPorts {
  ledger: Ledger;
  /** Crée la partie (GameManager) et retourne son id. */
  startGame(req: StartGameRequest): Promise<string>;
  /** Persistance (appelée à chaque transition, dans l'ordre). */
  persist(snapshot: SngSnapshot): Promise<void>;
  /** Notification temps réel des participants. */
  emit(snapshot: SngSnapshot): void;
  audit?: AuditSink;
  /** RNG injectable (tirage des couleurs) — déterministe dans les tests. */
  random?: () => number;
  now?: () => number;
}

export class SngError extends Error {
  constructor(readonly code:
    | "NOT_REGISTERING" | "ALREADY_REGISTERED" | "FULL" | "NOT_REGISTERED" | "BUSY"
    | "INSUFFICIENT_FUNDS" | "INVALID_CONFIG", message?: string) {
    super(message ?? code);
  }
}

interface Entry {
  userId: string;
  rating: number;
  status: SngPlayerView["status"];
  attempt: number;
  registeredSeq: number;
  seed: number | null;
  eliminatedRound: number | null;
  finalRank: number | null;
  payoutCents: Cents;
}

interface GameRec {
  gameId: string | null; // null tant que startGame n'a pas répondu
  white: string;
  black: string;
  kind: SngGameKind;
  result: FinishedGame["result"] | null;
  termination: FinishedGame["termination"] | null;
}

interface Match {
  round: number;
  slot: number;
  p1: string | null;
  p2: string | null;
  winner: string | null;
  status: "pending" | "playing" | "done";
  games: GameRec[];
}

/** Ordre de placement des têtes de série dans un tableau de taille 2^k. */
export function bracketOrder(bracketSize: number): number[] {
  let order = [1];
  while (order.length < bracketSize) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

export class SitAndGo {
  readonly id: string;
  private readonly cfg: Required<SitAndGoConfig>;
  private readonly ports: SitAndGoPorts;
  private readonly now: () => number;
  private readonly random: () => number;

  private status: SngSnapshot["status"] = "registering";
  private entries = new Map<string, Entry>();
  private rounds: Match[][] = [];
  private seq = 0;
  private pendingLocks = new Map<string, Promise<unknown>>();
  private persistChain: Promise<void> = Promise.resolve();
  private cancelReason: string | null = null;
  private rakeCents = 0;
  private finishing = false;
  private readonly createdAt: string;
  private startedAt: string | null = null;
  private finishedAt: string | null = null;

  constructor(cfg: SitAndGoConfig, ports: SitAndGoPorts) {
    if (![4, 6, 8].includes(cfg.size)) throw new SngError("INVALID_CONFIG", "taille 4, 6 ou 8");
    if (cfg.payoutBps.reduce((a, b) => a + b, 0) !== 10_000) throw new SngError("INVALID_CONFIG", "structure de gains ≠ 100 %");
    if (cfg.payoutBps.length > 2) throw new SngError("INVALID_CONFIG", "KO sans petite finale : 2 places payées au plus");
    this.id = cfg.id;
    this.cfg = { sponsorAddedCents: 0, ...cfg };
    this.ports = ports;
    this.now = ports.now ?? (() => Date.now());
    this.random = ports.random ?? Math.random;
    this.createdAt = new Date(this.now()).toISOString();
  }

  get escrowAccount(): string {
    return acct.tournamentEscrow(this.id, this.cfg.currency);
  }

  get currency(): SitAndGoConfig["currency"] {
    return this.cfg.currency;
  }

  get state(): SngSnapshot["status"] {
    return this.status;
  }

  /** Joueurs "actifs" (inscrits ou en cours d'inscription, ou en lice). */
  hasPlayer(userId: string): boolean {
    const e = this.entries.get(userId);
    return !!e && ["locking", "registered", "playing"].includes(e.status);
  }

  get registeredCount(): number {
    return [...this.entries.values()].filter((e) => e.status === "registered" || e.status === "locking").length;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Inscriptions
  // ═══════════════════════════════════════════════════════════════════════════
  async register(userId: string, rating: number): Promise<void> {
    if (this.status !== "registering") throw new SngError("NOT_REGISTERING");
    const prev = this.entries.get(userId);
    if (prev && (prev.status === "registered" || prev.status === "locking")) throw new SngError("ALREADY_REGISTERED");
    if (this.registeredCount >= this.cfg.size) throw new SngError("FULL");

    // Place réservée SYNCHRONEMENT (avant tout await) : deux inscriptions simultanées
    // ne peuvent pas prendre la dernière place toutes les deux.
    const entry: Entry = {
      userId, rating, status: "locking", attempt: (prev?.attempt ?? 0) + 1, registeredSeq: ++this.seq,
      seed: null, eliminatedRound: null, finalRank: null, payoutCents: 0,
    };
    this.entries.set(userId, entry);

    const lock = this.cfg.buyInCents > 0
      ? this.ports.ledger.post(`tlock:${this.id}:${userId}:${entry.attempt}`, this.cfg.currency, [
          { account: acct.user(userId, this.cfg.currency), amountCents: -this.cfg.buyInCents },
          { account: this.escrowAccount, amountCents: this.cfg.buyInCents },
        ], { kind: "tournament_lock", tournamentId: this.id, userId })
      : Promise.resolve();
    this.pendingLocks.set(userId, lock);
    try {
      await lock;
    } catch (e) {
      this.entries.delete(userId);
      if (prev) this.entries.set(userId, prev);
      throw e instanceof InsufficientFundsError ? new SngError("INSUFFICIENT_FUNDS") : e;
    } finally {
      this.pendingLocks.delete(userId);
    }

    entry.status = "registered";
    this.audit("register", { userId, attempt: entry.attempt });
    this.changed();
    if (this.status === "registering" && this.countStatus("registered") === this.cfg.size) await this.start();
  }

  async unregister(userId: string): Promise<void> {
    const e = this.entries.get(userId);
    if (!e || (e.status !== "registered" && e.status !== "locking")) throw new SngError("NOT_REGISTERED");
    if (e.status === "locking") throw new SngError("BUSY");
    if (this.status !== "registering") throw new SngError("NOT_REGISTERING");
    // statut changé AVANT l'await : la table ne peut pas démarrer avec ce joueur entre-temps
    e.status = "unregistered";
    try {
      if (this.cfg.buyInCents > 0) {
        await this.ports.ledger.post(`tunreg:${this.id}:${userId}:${e.attempt}`, this.cfg.currency, [
          { account: this.escrowAccount, amountCents: -this.cfg.buyInCents },
          { account: acct.user(userId, this.cfg.currency), amountCents: this.cfg.buyInCents },
        ], { kind: "tournament_unregister", tournamentId: this.id, userId });
      }
    } catch (err) {
      e.status = "registered"; // remboursement non écrit : le joueur reste inscrit
      throw err;
    }
    this.audit("unregister", { userId, attempt: e.attempt });
    this.changed();
  }

  /** Dotation d'un sponsor/streamer, versée dans l'escrow (non rakée). */
  async fundSponsor(sponsorAccount: string, cents: Cents): Promise<void> {
    if (this.status !== "registering") throw new SngError("NOT_REGISTERING");
    await this.ports.ledger.post(`tsponsor:${this.id}`, this.cfg.currency, [
      { account: sponsorAccount, amountCents: -cents },
      { account: this.escrowAccount, amountCents: cents },
    ], { kind: "tournament_sponsor", tournamentId: this.id });
    this.cfg.sponsorAddedCents = cents;
    this.changed();
  }

  /**
   * Annulation : rend à chaque contrepartie son apport net exact à l'escrow
   * (inscriptions moins désinscriptions déjà remboursées, dotation sponsor).
   */
  async cancel(reason: string): Promise<void> {
    if (this.status === "finished" || this.status === "cancelled") return;
    await Promise.allSettled(this.pendingLocks.values());
    this.status = "cancelled";
    this.cancelReason = reason;
    const contributions = (await this.ports.ledger.escrowContributions(this.escrowAccount, this.cfg.currency))
      .filter((c) => c.netCents > 0);
    const total = contributions.reduce((a, c) => a + c.netCents, 0);
    if (total > 0) {
      await this.ports.ledger.post(`tcancel:${this.id}`, this.cfg.currency, [
        { account: this.escrowAccount, amountCents: -total },
        ...contributions.map((c) => ({ account: c.account, amountCents: c.netCents })),
      ], { kind: "tournament_cancel", tournamentId: this.id, reason });
    }
    for (const e of this.entries.values()) {
      if (["registered", "playing", "locking"].includes(e.status)) e.status = "refunded";
    }
    this.finishedAt = new Date(this.now()).toISOString();
    this.audit("cancel", { reason, refunded: contributions });
    this.changed();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Déroulement
  // ═══════════════════════════════════════════════════════════════════════════
  private async start(): Promise<void> {
    this.status = "running";
    this.startedAt = new Date(this.now()).toISOString();
    const players = [...this.entries.values()]
      .filter((e) => e.status === "registered")
      .sort((a, b) => b.rating - a.rating || a.registeredSeq - b.registeredSeq);
    players.forEach((e, i) => { e.seed = i + 1; e.status = "playing"; });

    const bracketSize = this.cfg.size === 4 ? 4 : 8;
    const order = bracketOrder(bracketSize);
    const bySeed = new Map(players.map((p) => [p.seed!, p.userId]));
    const first: Match[] = [];
    for (let i = 0; i < order.length; i += 2) {
      const a = bySeed.get(order[i]!) ?? null;
      const b = bySeed.get(order[i + 1]!) ?? null;
      const m: Match = { round: 1, slot: i / 2, p1: a ?? b, p2: a ? b : null, winner: null, status: "pending", games: [] };
      if (!m.p2) { m.winner = m.p1; m.status = "done"; } // exempt
      first.push(m);
    }
    this.rounds = [first];
    for (let r = 2; (bracketSize >> (r - 1)) >= 2; r++) {
      this.rounds.push(Array.from({ length: bracketSize >> r }, (_, slot) => ({
        round: r, slot, p1: null, p2: null, winner: null, status: "pending" as const, games: [],
      })));
    }

    this.audit("start", { seeds: players.map((p) => ({ userId: p.userId, seed: p.seed, rating: p.rating })) });
    // La ligne `tournaments` doit exister avant les parties (clé étrangère games.tournament_id).
    try {
      await this.persistNow();
    } catch (e) {
      console.error(`[sng ${this.id}] persistance impossible au démarrage, annulation`, e);
      return this.cancel("persistence_error");
    }
    this.emit();
    await this.advance();
  }

  /** Remonte les vainqueurs, démarre les matchs prêts, clôture si la finale est jouée. */
  private async advance(): Promise<void> {
    for (let r = 0; r < this.rounds.length; r++) {
      const round = this.rounds[r]!;
      if (r > 0) {
        const prev = this.rounds[r - 1]!;
        if (!prev.every((m) => m.status === "done")) break; // un tour à la fois
        for (const m of round) {
          if (m.p1 === null) m.p1 = prev[m.slot * 2]!.winner;
          if (m.p2 === null) m.p2 = prev[m.slot * 2 + 1]!.winner;
        }
      }
      for (const m of round) {
        if (m.status === "pending" && m.p1 && m.p2) await this.startGame(m, "main");
      }
    }
    const final = this.rounds.at(-1)![0]!;
    if (final.status === "done" && this.status === "running" && !this.finishing) {
      this.finishing = true;
      await this.finish(final);
    }
  }

  private seedOf(userId: string): number {
    return this.entries.get(userId)!.seed!;
  }

  private async startGame(m: Match, kind: SngGameKind): Promise<void> {
    const p1 = m.p1!;
    const p2 = m.p2!;
    let white: string;
    if (kind === "main") white = this.random() < 0.5 ? p1 : p2;
    else if (kind === "rematch") white = m.games.at(-1)!.black;
    else white = this.seedOf(p1) > this.seedOf(p2) ? p1 : p2; // Armageddon : la moins bonne tête de série a les Blancs
    const black = white === p1 ? p2 : p1;

    const rec: GameRec = { gameId: randomUUID(), white, black, kind, result: null, termination: null };
    m.games.push(rec);
    m.status = "playing";
    const seat = (u: string): Seat => ({ userId: u, rating: this.entries.get(u)!.rating });
    await this.ports.startGame({
      gameId: rec.gameId!, white: seat(white), black: seat(black), timeControl: this.cfg.timeControl, currency: this.cfg.currency,
      rated: kind !== "armageddon",
      tournament: { tournamentId: this.id, round: m.round, slot: m.slot, kind },
    });
    this.changed();
  }

  /** Résultat d'une partie de ce tournoi (idempotent). */
  async onGameFinished(g: FinishedGame): Promise<void> {
    if (this.status !== "running" || g.tournament?.tournamentId !== this.id) return;
    const m = this.rounds[g.tournament.round - 1]?.[g.tournament.slot];
    const rec = m?.games.find((x) => x.gameId === g.gameId);
    if (!m || !rec || rec.result !== null || m.status === "done") return;
    rec.result = g.result;
    rec.termination = g.termination;

    const colorPlayer = (c: Color) => (c === "w" ? rec.white : rec.black);
    let winner: string | null = null;
    if (g.aborted) {
      if (g.abortedBy) winner = colorPlayer(g.abortedBy === "w" ? "b" : "w");
      else { this.changed(); return this.startGame(m, rec.kind); } // personne en cause : on rejoue
    } else if (g.result === "1-0") winner = rec.white;
    else if (g.result === "0-1") winner = rec.black;
    else if (rec.kind === "armageddon") winner = rec.black; // nulle = qualification des Noirs
    else {
      this.audit("tiebreak", { round: m.round, slot: m.slot, next: rec.kind === "main" ? "rematch" : "armageddon" });
      this.changed();
      return this.startGame(m, rec.kind === "main" ? "rematch" : "armageddon");
    }

    m.winner = winner;
    m.status = "done";
    const loser = winner === m.p1 ? m.p2! : m.p1!;
    const le = this.entries.get(loser)!;
    le.status = "eliminated";
    le.eliminatedRound = m.round;
    this.audit("match_done", { round: m.round, slot: m.slot, winner, loser, games: m.games.map((x) => x.gameId) });
    this.changed();
    await this.advance();
  }

  private async finish(final: Match): Promise<void> {
    const winner = final.winner!;
    const finalist = final.p1 === winner ? final.p2! : final.p1!;
    const others = [...this.entries.values()]
      .filter((e) => e.status === "eliminated" && e.userId !== finalist)
      .sort((a, b) => b.eliminatedRound! - a.eliminatedRound! || a.seed! - b.seed!);
    const ranking = [winner, finalist, ...others.map((e) => e.userId)];

    const plan = settleTournament(
      this.cfg.buyInCents, this.cfg.size, ranking, this.cfg.payoutBps, this.cfg.rakeBps, this.cfg.sponsorAddedCents,
    );
    if (plan.potCents > 0) {
      // Rejoué tant qu'il échoue (clé idempotente) : le résultat sportif est acquis,
      // seul le paiement attend. Après un crash, la récupération rembourse l'escrow.
      for (let attempt = 1; ; attempt++) {
        try {
          await applySettlement(this.ports.ledger, `t-${this.id}`, this.cfg.currency, plan, { tournamentId: this.id, ranking });
          break;
        } catch (e) {
          if (attempt >= 5) throw e;
          console.error(`[sng ${this.id}] règlement échoué (essai ${attempt})`, e);
          await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
        }
      }
    }
    this.rakeCents = plan.rakeCents;

    const rankOf = (e: Entry) => {
      if (e.userId === winner) return 1;
      if (e.userId === finalist) return 2;
      const totalRounds = this.rounds.length;
      return 2 ** (totalRounds - e.eliminatedRound!) + 1; // demi-finalistes 3e ex aequo, quarts 5e…
    };
    for (const e of this.entries.values()) {
      if (e.seed === null) continue;
      e.finalRank = rankOf(e);
      e.payoutCents = plan.payouts[e.userId] ?? 0;
    }
    this.entries.get(winner)!.status = "winner";
    this.status = "finished";
    this.finishedAt = new Date(this.now()).toISOString();
    this.audit("finish", { ranking, payouts: plan.payouts, rakeCents: plan.rakeCents });
    this.changed();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Instantané, persistance, notifications
  // ═══════════════════════════════════════════════════════════════════════════
  snapshot(): SngSnapshot {
    const rake = this.status === "finished" ? this.rakeCents : computeRake(this.cfg.buyInCents * this.cfg.size, this.cfg.rakeBps);
    return {
      id: this.id, formatId: this.cfg.formatId, size: this.cfg.size, timeControl: this.cfg.timeControl,
      currency: this.cfg.currency, buyInCents: this.cfg.buyInCents, sponsorAddedCents: this.cfg.sponsorAddedCents,
      rakeBps: this.cfg.rakeBps, payoutBps: [...this.cfg.payoutBps], status: this.status,
      players: [...this.entries.values()]
        .filter((e) => e.status !== "unregistered")
        .sort((a, b) => (a.seed ?? 99) - (b.seed ?? 99) || a.registeredSeq - b.registeredSeq)
        .map((e) => ({
          userId: e.userId, rating: e.rating, seed: e.seed, status: e.status,
          eliminatedRound: e.eliminatedRound, finalRank: e.finalRank, payoutCents: e.payoutCents,
        })),
      rounds: this.rounds.map((r) => r.map((m): SngMatchView => ({
        round: m.round, slot: m.slot, p1: m.p1, p2: m.p2, winner: m.winner, status: m.status,
        games: m.games.filter((g) => g.gameId).map((g): SngGameView => ({
          gameId: g.gameId!, white: g.white, black: g.black, kind: g.kind, result: g.result, termination: g.termination,
        })),
      }))),
      currentRound: this.rounds.findIndex((r) => r.some((m) => m.status !== "done")) + 1,
      prizePoolCents: this.cfg.buyInCents * this.cfg.size - rake + this.cfg.sponsorAddedCents,
      rakeCents: this.status === "finished" ? this.rakeCents : 0,
      cancelReason: this.cancelReason,
      createdAt: this.createdAt, startedAt: this.startedAt, finishedAt: this.finishedAt,
    };
  }

  /** Persistance sérialisée (un seul write en vol par tournoi, ordre préservé). */
  private persistNow(): Promise<void> {
    const snap = this.snapshot();
    const p = this.persistChain.then(() => this.ports.persist(snap));
    this.persistChain = p.catch((e) => console.error(`[sng ${this.id}] persistance échouée`, e));
    return p;
  }

  private changed(): void {
    void this.persistNow().catch(() => {});
    this.emit();
  }

  private emit(): void {
    this.ports.emit(this.snapshot());
  }

  /** Attend que toutes les écritures en cours soient faites (tests, arrêt propre). */
  flush(): Promise<void> {
    return this.persistChain;
  }

  private countStatus(s: Entry["status"]): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.status === s) n++;
    return n;
  }

  private audit(event: string, data: Record<string, unknown>): void {
    this.ports.audit?.append("tournament.event", { tournamentId: this.id, event, ...data });
  }
}
