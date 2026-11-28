import { randomUUID } from "node:crypto";
import { SNG_MAX_SIZE, SNG_MIN_SIZE, SWISS_MAX_ROUNDS } from "@chessarena/shared";
import type {
  ClubRef, Color, Cents, Currency, GameResult, SngGameKind, SngGameView, SngMatchView, SngPlayerView, SngSize, SngSnapshot, SngSystem, TimeControlId,
} from "@chessarena/shared";
import { arenaPairs, arenaRanking, arenaScores, teamStandings, type ArenaGame } from "./arena.js";
import { ARENA_MINUTES } from "@chessarena/shared";
import { defaultSwissRounds, pairRound, swissStandings, type SwissResult, type SwissStanding } from "./swiss.js";
import type { FinishedGame, Seat, TournamentGameRef } from "../game/GameRoom.js";
import { acct, applySettlement, InsufficientFundsError, type Ledger } from "../settlement/ledger.js";
import { computeRake, fitStructure, settleTournament } from "../settlement/rake.js";
import type { AuditSink } from "../audit/auditLog.js";

/**
 * Moteur de tournoi — élimination directe (KO), de 3 à 128 joueurs (tables officielles : 4, 6 ou 8).
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
 *   • Tableau = puissance de 2 immédiatement supérieure au nombre de joueurs : les meilleures têtes de
 *     série sont exemptes au 1er tour (6 joueurs → tableau de 8, têtes 1 et 2 exemptes ; 50 → 64, 14 exempts).
 *   • Le créateur peut lancer un tournoi incomplet (≥ 3 inscrits) : même règle d'exempts.
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
 *
 * SYSTÈME SUISSE (`system: "swiss"`, voir swiss.ts)
 *   • Tout le monde joue toutes les rondes (une partie par ronde, la nulle compte ½ point) ;
 *     un exempt (nombre impair) marque 1 point. Rondes : `swissRounds`, sinon selon le nombre d'inscrits.
 *   • Une ronde n'est appariée que lorsque la précédente est entièrement terminée.
 *   • Classement final : points, Buchholz, Sonneborn-Berger, victoires, tête de série ; jusqu'à 3 places payées.
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
  /** tournoi créé par un joueur : son identifiant, et le nom choisi */
  createdBy?: string | null;
  name?: string | null;
  /** « ko » (défaut) ou « swiss » */
  system?: SngSystem;
  /** suisse : rondes souhaitées (0 = selon le nombre d'inscrits) */
  swissRounds?: number;
  /** départ programmé (ISO) : la table ne démarre pas toute seule quand elle est complète */
  startsAt?: string | null;
  /** reprise après redémarrage : date de création d'origine */
  createdAt?: string;
  /** arena : durée en minutes */
  arenaMinutes?: number;
  /** tournoi programmé répété chaque semaine */
  repeatWeekly?: boolean;
  /** tournoi d'un club */
  club?: ClubRef | null;
  /** réservé aux membres du club (contrôlé à l'inscription par le serveur) */
  membersOnly?: boolean;
  /** bataille de clubs (arena) */
  teamBattle?: { leaders: number; teams: ClubRef[] } | null;
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
  /** suisse : pause entre deux rondes (voir son résultat et le classement), 0 par défaut */
  swissPauseMs?: number;
  /** arena : intervalle des vagues d'appariement (défaut 3 s ; 0 = seulement via arenaTick(), pour les tests) */
  arenaTickMs?: number;
  /** reprise après redémarrage : délai avant de relancer les parties (le temps que les joueurs se reconnectent) */
  resumeDelayMs?: number;
}

/** inscriptions comptées (bataille de clubs : effectifs des clubs) */
const ACTIVE_ENTRY = new Set(["locking", "registered", "playing", "winner", "eliminated"]);

export class SngError extends Error {
  constructor(readonly code:
    | "NOT_REGISTERING" | "ALREADY_REGISTERED" | "FULL" | "NOT_REGISTERED" | "BUSY"
    | "INSUFFICIENT_FUNDS" | "INVALID_CONFIG" | "NOT_ENOUGH_PLAYERS" | "NOT_CLUB_MEMBER" | "REMOVED_BY_ORGANIZER", message?: string) {
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
  /** suisse : adversaires et couleurs jouées (« - » = exempt) */
  opponents: string[];
  colors: Array<"w" | "b" | "-">;
  hadBye: boolean;
  /** arena : en pause (pas de nouvel adversaire) */
  paused?: boolean;
  /** bataille de clubs : club défendu */
  team?: string | null;
  /** suisse : retiré (plus apparié) ; forfaits consécutifs (2 = retrait automatique) */
  withdrawn?: boolean;
  forfeits?: number;
}

interface GameRec {
  gameId: string | null; // null tant que startGame n'a pas répondu
  white: string;
  black: string;
  kind: SngGameKind;
  result: FinishedGame["result"] | null;
  termination: FinishedGame["termination"] | null;
  /** Arena : berserk et longueur de la partie (bonus) */
  berserk?: { w: boolean; b: boolean };
  plies?: number;
}

interface Match {
  round: number;
  slot: number;
  p1: string | null;
  p2: string | null;
  winner: string | null;
  status: "pending" | "playing" | "done";
  games: GameRec[];
  /** suisse : résultat de l'échiquier */
  result?: GameResult | "bye" | null;
}

/** Taille du tableau : puissance de 2 immédiatement supérieure (ou égale) au nombre de joueurs. */
export function bracketSizeFor(players: number): number {
  let b = 2;
  while (b < players) b *= 2;
  return b;
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
  /** après une reprise : les clés d'idempotence des inscriptions repartent au-delà de cette base */
  private attemptBase = 0;
  /** joueurs réellement au départ (≤ size si le créateur a lancé un tournoi incomplet) */
  private entrants = 0;
  private readonly createdAt: string;
  private startedAt: string | null = null;
  private finishedAt: string | null = null;

  constructor(cfg: SitAndGoConfig, ports: SitAndGoPorts) {
    if (!Number.isInteger(cfg.size) || cfg.size < SNG_MIN_SIZE || cfg.size > SNG_MAX_SIZE) throw new SngError("INVALID_CONFIG", "taille de 3 à 128");
    if (cfg.payoutBps.reduce((a, b) => a + b, 0) !== 10_000) throw new SngError("INVALID_CONFIG", "structure de gains ≠ 100 %");
    const swiss = cfg.system === "swiss";
    const podium = swiss || cfg.system === "arena";
    if (cfg.payoutBps.length > (podium ? 3 : 2)) throw new SngError("INVALID_CONFIG", podium ? "3 places payées au plus" : "KO sans petite finale : 2 places payées au plus");
    if (cfg.teamBattle && (cfg.system !== "arena" || cfg.teamBattle.teams.length < 2 || cfg.teamBattle.teams.length > 8 || cfg.teamBattle.leaders < 1)) throw new SngError("INVALID_CONFIG", "bataille de clubs");
    if (cfg.system === "arena" && !(ARENA_MINUTES as readonly number[]).includes(cfg.arenaMinutes ?? 0)) throw new SngError("INVALID_CONFIG", "durée d'arena");
    if (swiss && cfg.swissRounds && (!Number.isInteger(cfg.swissRounds) || cfg.swissRounds < 1 || cfg.swissRounds > SWISS_MAX_ROUNDS)) throw new SngError("INVALID_CONFIG", "rondes");
    this.id = cfg.id;
    this.cfg = { sponsorAddedCents: 0, createdBy: null, name: null, system: "ko", swissRounds: 0, startsAt: null, createdAt: "", arenaMinutes: 0, repeatWeekly: false, club: null, teamBattle: null, membersOnly: false, ...cfg };
    this.ports = ports;
    this.now = ports.now ?? (() => Date.now());
    this.random = ports.random ?? Math.random;
    this.createdAt = cfg.createdAt || new Date(this.now()).toISOString();
  }

  /** départ programmé (ms epoch), sinon null */
  get startsAtMs(): number | null {
    return this.cfg.startsAt ? Date.parse(this.cfg.startsAt) : null;
  }

  /**
   * Reprise après un redémarrage du serveur : inscriptions déjà payées (l'escrow est intact en base),
   * sans nouvelle écriture comptable. Les numéros de tentative repartent d'une base unique
   * (horodatage) : une désinscription ou réinscription ultérieure aura une clé d'idempotence neuve.
   */
  restoreRegistrations(players: ReadonlyArray<{ userId: string; rating: number; team?: string | null }>): void {
    if (this.status !== "registering" || this.entries.size) throw new SngError("INVALID_CONFIG", "reprise sur une table neuve uniquement");
    const base = Math.floor(this.now() / 1000) * 10;
    this.attemptBase = base;
    for (const p of players) {
      this.entries.set(p.userId, {
        userId: p.userId, rating: p.rating, status: "registered", attempt: base, registeredSeq: ++this.seq,
        seed: null, eliminatedRound: null, finalRank: null, payoutCents: 0, opponents: [], colors: [], hadBye: false, team: p.team ?? null,
      });
    }
    this.audit("restore", { players: players.map((p) => p.userId) });
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
  /** a pris part au tournoi (inscrit, en jeu, éliminé, vainqueur) : peut écrire dans le chat du tournoi */
  isParticipant(userId: string): boolean {
    const e = this.entries.get(userId);
    return !!e && e.status !== "unregistered" && e.status !== "refunded";
  }

  hasPlayer(userId: string): boolean {
    const e = this.entries.get(userId);
    if (!e || !["locking", "registered", "playing"].includes(e.status)) return false;
    // retiré d'un tournoi en cours : libre, sauf s'il finit encore une partie du tournoi
    if (e.withdrawn) return this.rounds.flat().some((m) => m.status === "playing" && (m.p1 === userId || m.p2 === userId));
    return true;
  }

  get registeredCount(): number {
    return [...this.entries.values()].filter((e) => e.status === "registered" || e.status === "locking").length;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Inscriptions
  // ═══════════════════════════════════════════════════════════════════════════
  /**
   * Reprise d'un tournoi EN COURS après un redémarrage du serveur (mise en ligne) : classement, rondes et parties
   * terminées sont repris de l'instantané ; les parties interrompues (perdues avec le serveur) sont rejouées
   * (suisse, KO) ou annulées sans effet (arena, qui reprend avec le temps restant). L'escrow est intact en base.
   */
  async restoreRunning(s: SngSnapshot): Promise<void> {
    if (this.status !== "registering" || this.entries.size || s.status !== "running") throw new SngError("INVALID_CONFIG", "reprise d'un tournoi en cours uniquement");
    const base = Math.floor(this.now() / 1000) * 10;
    this.attemptBase = base;
    this.status = "running";
    this.startedAt = s.startedAt;
    const flat = s.rounds.flat();
    for (const p of s.players) {
      if (p.status !== "playing" && p.status !== "eliminated" && p.status !== "winner") continue;
      const mine = flat.filter((m) => m.p1 === p.userId || m.p2 === p.userId);
      this.entries.set(p.userId, {
        userId: p.userId, rating: p.rating, status: p.status === "winner" ? "playing" : p.status, attempt: base, registeredSeq: ++this.seq,
        seed: p.seed, eliminatedRound: p.eliminatedRound, finalRank: null, payoutCents: 0,
        opponents: mine.filter((m) => m.p2).map((m) => (m.p1 === p.userId ? m.p2! : m.p1!)),
        colors: mine.map((m) => (!m.p2 ? "-" : m.p1 === p.userId ? "w" : "b")),
        hadBye: mine.some((m) => m.result === "bye"), team: p.team ?? null, paused: p.paused, withdrawn: p.withdrawn, forfeits: 0,
      });
    }
    this.entrants = [...this.entries.values()].filter((e) => e.seed !== null).length;
    this.lateSeed = Math.max(0, ...[...this.entries.values()].map((e) => e.seed ?? 0));
    const ko = this.cfg.system === "ko";
    this.rounds = s.rounds.map((r) => r.map((m): Match => {
      const games: GameRec[] = m.games.filter((g) => g.result).map((g) => ({ gameId: g.gameId, white: g.white, black: g.black, kind: g.kind, result: g.result, termination: g.termination,
        ...(g.berserk ? { berserk: g.berserk } : {}), ...(g.plies !== undefined ? { plies: g.plies } : {}) }));
      const done = ko ? m.status === "done" : m.result !== null && m.result !== undefined;
      return { round: m.round, slot: m.slot, p1: m.p1, p2: m.p2, winner: m.winner, status: done ? "done" : "pending", games, result: m.result ?? null };
    }));
    if (this.cfg.system === "swiss") this.totalRounds = s.totalRounds ?? this.plannedRounds(this.entrants);
    this.audit("restore_running", { rounds: this.rounds.length, players: this.entries.size });
    if (this.cfg.system === "arena") this.arenaEndAt = s.arenaEndsAt ? Date.parse(s.arenaEndsAt) : this.now();
    await this.persistNow();
    this.emit();
    const delay = this.ports.resumeDelayMs ?? 0;
    if (delay > 0) {
      setTimeout(() => void this.resumeAfterRestore().catch((e) => console.error(`[sng ${this.id}] reprise`, e)), delay).unref?.();
      return;
    }
    await this.resumeAfterRestore();
  }

  private async resumeAfterRestore(): Promise<void> {
    if (this.status !== "running") return;
    const ko = this.cfg.system === "ko";
    if (this.cfg.system === "arena") {
      // parties interrompues : annulées sans effet (personne ne perd de points ni sa série)
      for (const m of this.rounds[0] ?? []) if (m.status === "pending") { m.status = "done"; m.result = null; }
      const every = this.ports.arenaTickMs ?? 3_000;
      if (every > 0) {
        this.arenaTimer = setInterval(() => void this.arenaTick().catch((e) => console.error(`[sng ${this.id}] arena`, e)), every);
        this.arenaTimer.unref?.();
      }
      this.changed();
      return this.arenaTick();
    }
    // suisse et KO : on rejoue les parties interrompues (KO : la suite logique du match — revanche, Armageddon)
    const cur = this.cfg.system === "swiss" ? this.rounds.at(-1) ?? [] : this.rounds.flat();
    for (const m of cur) {
      if (m.status !== "pending" || !m.p1 || !m.p2) continue;
      const last = m.games.at(-1);
      const kind: SngGameKind = !ko || !last ? "main" : last.kind === "main" ? "rematch" : "armageddon";
      await this.startGame(m, kind);
    }
    this.changed();
    await this.advance();
  }

  /** joueurs retirés par l'organisateur : plus d'inscription possible à ce tournoi */
  private readonly kicked = new Set<string>();

  /** L'organisateur retire un inscrit avant le départ : remboursé, ne peut plus se réinscrire. */
  async kick(userId: string): Promise<void> {
    if (this.status !== "registering") throw new SngError("NOT_REGISTERING");
    await this.unregister(userId);
    this.kicked.add(userId);
    this.audit("kick", { userId });
  }

  async register(userId: string, rating: number, team: string | null = null): Promise<void> {
    if (this.kicked.has(userId)) throw new SngError("REMOVED_BY_ORGANIZER");
    if (this.cfg.teamBattle && (!team || !this.cfg.teamBattle.teams.some((t) => t.slug === team))) throw new SngError("NOT_CLUB_MEMBER");
    // arena : on peut arriver en cours de route (jusqu'à 1 minute de la fin)
    const lateArena = this.cfg.system === "arena" && this.status === "running" && this.arenaEndAt !== null && this.now() < this.arenaEndAt - 60_000;
    if (this.status !== "registering" && !lateArena) throw new SngError("NOT_REGISTERING");
    const prev = this.entries.get(userId);
    if (prev && (prev.status === "registered" || prev.status === "locking" || prev.status === "playing")) throw new SngError("ALREADY_REGISTERED");
    const taken = [...this.entries.values()].filter((e) => e.status === "registered" || e.status === "locking" || e.status === "playing").length;
    if (taken >= this.cfg.size) throw new SngError("FULL");

    // Place réservée SYNCHRONEMENT (avant tout await) : deux inscriptions simultanées
    // ne peuvent pas prendre la dernière place toutes les deux.
    const entry: Entry = {
      userId, rating, status: "locking", attempt: Math.max(prev?.attempt ?? 0, this.attemptBase) + 1, registeredSeq: ++this.seq,
      seed: null, eliminatedRound: null, finalRank: null, payoutCents: 0, opponents: [], colors: [], hadBye: false, team,
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

    if (lateArena && this.status === "running") {
      // arrivée en cours d'arena : directement en jeu, appariée à la prochaine vague
      entry.status = "playing";
      entry.seed = ++this.lateSeed;
      this.entrants++;
      this.audit("register_late", { userId, attempt: entry.attempt });
      this.changed();
      return;
    }
    entry.status = "registered";
    this.audit("register", { userId, attempt: entry.attempt });
    this.changed();
    // table complète : départ immédiat, sauf tournoi programmé (il attend son heure) et arena (lancée par le créateur ou à l'heure)
    if (this.status === "registering" && !this.cfg.startsAt && this.cfg.system !== "arena" && this.countStatus("registered") === this.cfg.size) await this.start();
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
    this.stopArenaTimer();
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

  /**
   * Départ anticipé (tournoi incomplet) : au moins 3 inscrits, aucune inscription en cours de paiement.
   * `minPlayers` : une Arena officielle part à l'heure même avec moins d'inscrits (on la rejoint en cours de route).
   */
  async startNow(minPlayers = SNG_MIN_SIZE): Promise<void> {
    if (this.status !== "registering") throw new SngError("NOT_REGISTERING");
    if (this.pendingLocks.size > 0) throw new SngError("BUSY");
    if (minPlayers < SNG_MIN_SIZE && this.cfg.system !== "arena") throw new SngError("NOT_ENOUGH_PLAYERS");
    if (this.countStatus("registered") < minPlayers) throw new SngError("NOT_ENOUGH_PLAYERS");
    this.audit("start_early", { registered: this.countStatus("registered"), size: this.cfg.size });
    await this.start();
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

    this.entrants = players.length;
    if (this.cfg.system === "swiss") return this.startSwiss(players);
    if (this.cfg.system === "arena") return this.startArena(players);
    const bracketSize = bracketSizeFor(players.length);
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
    if (this.cfg.system === "swiss") return this.advanceSwiss();
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
    if (this.cfg.system !== "ko") white = p1; // couleurs fixées par l'appariement
    else if (kind === "main") white = this.random() < 0.5 ? p1 : p2;
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
      tournament: { tournamentId: this.id, round: m.round, slot: m.slot, kind, ...(this.cfg.system === "swiss" ? { swiss: true } : {}), ...(this.cfg.system === "arena" ? { arena: true } : {}) },
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
    if (this.cfg.system === "arena") {
      if (g.berserk) rec.berserk = g.berserk;
      rec.plies = g.moveTimesMs.length;
      // annulée sans responsable : ni points ni série touchés ; premier coup non joué : forfait du responsable
      m.result = g.aborted ? (g.abortedBy ? (g.abortedBy === "w" ? "0-1" : "1-0") : null) : g.result;
      m.winner = m.result === "1-0" ? rec.white : m.result === "0-1" ? rec.black : null;
      m.status = "done";
      // premier coup non joué : le joueur est sans doute absent, on le met en pause (il reprend d'un clic)
      if (g.aborted && g.abortedBy) {
        const absent = this.entries.get(colorPlayer(g.abortedBy));
        if (absent) { absent.paused = true; this.audit("arena_auto_pause", { userId: absent.userId }); }
      }
      this.audit("arena_game", { slot: m.slot, result: m.result, aborted: g.aborted, game: rec.gameId });
      this.changed();
      if (this.arenaEndAt !== null && this.now() >= this.arenaEndAt) await this.arenaTick();
      return;
    }
    if (this.cfg.system === "swiss") {
      let result: GameResult;
      if (g.aborted) {
        if (!g.abortedBy) { this.changed(); return this.startGame(m, rec.kind); } // personne en cause : on rejoue
        result = g.abortedBy === "w" ? "0-1" : "1-0"; // forfait du responsable
        // deux forfaits de suite : joueur absent, retiré des appariements (il garde ses points)
        const absent = this.entries.get(colorPlayer(g.abortedBy));
        if (absent) {
          absent.forfeits = (absent.forfeits ?? 0) + 1;
          if (absent.forfeits >= 2 && !absent.withdrawn) { absent.withdrawn = true; this.audit("swiss_auto_withdraw", { userId: absent.userId }); }
        }
      } else {
        result = g.result;
        for (const u of [rec.white, rec.black]) { const e = this.entries.get(u); if (e) e.forfeits = 0; }
      }
      m.result = result;
      m.winner = result === "1-0" ? rec.white : result === "0-1" ? rec.black : null;
      m.status = "done";
      this.audit("board_done", { round: m.round, slot: m.slot, result, game: rec.gameId });
      this.changed();
      return this.advance();
    }
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

  // ═══════════════════════════════════════════════════════════════════════════
  // Arena
  // ═══════════════════════════════════════════════════════════════════════════
  private arenaEndAt: number | null = null;
  private arenaTimer: ReturnType<typeof setInterval> | null = null;
  private lateSeed = 0;
  private ticking = false;

  private stopArenaTimer(): void {
    if (this.arenaTimer) clearInterval(this.arenaTimer);
    this.arenaTimer = null;
  }

  private async startArena(players: Entry[]): Promise<void> {
    this.arenaEndAt = this.now() + (this.cfg.arenaMinutes ?? 30) * 60_000;
    this.lateSeed = players.length;
    this.rounds = [[]];
    this.audit("start", { system: "arena", minutes: this.cfg.arenaMinutes, endsAt: new Date(this.arenaEndAt).toISOString(), seeds: players.map((p) => ({ userId: p.userId, seed: p.seed, rating: p.rating })) });
    try {
      await this.persistNow();
    } catch (e) {
      console.error(`[sng ${this.id}] persistance impossible au démarrage, annulation`, e);
      return this.cancel("persistence_error");
    }
    this.emit();
    const every = this.ports.arenaTickMs ?? 3_000;
    if (every > 0) {
      this.arenaTimer = setInterval(() => void this.arenaTick().catch((e) => console.error(`[sng ${this.id}] arena`, e)), every);
      this.arenaTimer.unref?.();
    }
    await this.arenaTick();
  }

  private arenaGames(): ArenaGame[] {
    return (this.rounds[0] ?? []).map((m) => {
      const forfeit = m.result && m.games.at(-1)?.termination === "aborted";
      const last = m.games.at(-1);
      return { white: m.p1!, black: m.p2!, result: !m.result || m.result === "bye" ? null : forfeit ? (m.result === "0-1" ? "forfeit-w" : "forfeit-b") : m.result,
        ...(last?.berserk ? { berserk: last.berserk, plies: last.plies ?? 0 } : {}) };
    });
  }

  /**
   * Une vague : avant l'heure de fin, apparie les joueurs libres ; après, attend la fin des parties en cours
   * puis clôture. Appelée par le minuteur (et directement dans les tests).
   */
  async arenaTick(): Promise<void> {
    if (this.status !== "running" || this.cfg.system !== "arena" || this.ticking) return;
    this.ticking = true;
    try {
      const games = this.rounds[0]!;
      const busy = new Set(games.filter((m) => m.status !== "done").flatMap((m) => [m.p1!, m.p2!]));
      if (this.now() >= this.arenaEndAt!) {
        this.stopArenaTimer();
        if (!busy.size && !this.finishing) { this.finishing = true; await this.finishArena(); }
        return;
      }
      const scores = arenaScores([...this.entries.keys()], this.arenaGames());
      const lastOpp = new Map<string, string>();
      for (const m of games) { lastOpp.set(m.p1!, m.p2!); lastOpp.set(m.p2!, m.p1!); }
      const waiting = [...this.entries.values()]
        .filter((e) => e.status === "playing" && !e.paused && !busy.has(e.userId))
        .map((e) => ({
          id: e.userId, score: scores.get(e.userId)?.score ?? 0, rating: e.rating, lastOpponent: lastOpp.get(e.userId) ?? null,
          whites: e.colors.filter((c) => c === "w").length, blacks: e.colors.filter((c) => c === "b").length, team: e.team ?? null,
        }));
      const pairs = arenaPairs(waiting, this.random);
      for (const [w, b] of pairs) {
        const m: Match = { round: 1, slot: games.length, p1: w, p2: b, winner: null, status: "pending", games: [], result: null };
        games.push(m);
        const ew = this.entries.get(w)!, eb = this.entries.get(b)!;
        ew.colors.push("w"); eb.colors.push("b"); ew.opponents.push(b); eb.opponents.push(w);
        await this.startGame(m, "main");
      }
      if (pairs.length) { this.audit("arena_pairing", { pairs }); this.changed(); }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Quitter un tournoi en cours : suisse → plus apparié (la partie en cours se joue, les points restent) ;
   * arena → pause définitive. Les gains éventuels restent dus au classement final.
   */
  async withdraw(userId: string): Promise<void> {
    const e = this.entries.get(userId);
    if (this.status !== "running" || !e || e.status !== "playing" || this.cfg.system === "ko") throw new SngError("NOT_REGISTERED");
    if (this.cfg.system === "arena") e.paused = true;
    e.withdrawn = true;
    this.audit("withdraw", { userId });
    this.changed();
    if (this.cfg.system === "swiss") await this.advance();
  }

  /** Pause (plus de nouvel adversaire, la partie en cours continue) ou reprise. */
  async setPaused(userId: string, paused: boolean): Promise<void> {
    const e = this.entries.get(userId);
    if (this.cfg.system !== "arena" || !e || e.status !== "playing" || this.status !== "running") throw new SngError("NOT_REGISTERED");
    e.paused = paused;
    if (!paused) e.withdrawn = false;
    this.audit(paused ? "arena_pause" : "arena_resume", { userId });
    this.changed();
  }

  private async finishArena(): Promise<void> {
    // personne n'a joué (Arena officielle restée vide, joueur seul) : annulée, entrées remboursées
    if (!this.arenaGames().some((g) => g.result === "1-0" || g.result === "0-1" || g.result === "1/2-1/2")) return this.cancel("aucune partie jouée");
    const ratings = new Map([...this.entries.values()].map((e) => [e.userId, e.rating]));
    const players = [...this.entries.values()].filter((e) => e.status === "playing").map((e) => e.userId);
    const scores = arenaScores(players, this.arenaGames());
    const ranking = arenaRanking(new Map(players.map((u) => [u, scores.get(u)!])), ratings);
    const plan = settleTournament(this.cfg.buyInCents, this.entrants, ranking, fitStructure(this.cfg.payoutBps, ranking.length), this.cfg.rakeBps, this.cfg.sponsorAddedCents);
    if (plan.potCents > 0) {
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
    ranking.forEach((u, i) => {
      const e = this.entries.get(u)!;
      e.finalRank = i + 1;
      e.payoutCents = plan.payouts[u] ?? 0;
      e.status = i === 0 ? "winner" : "eliminated";
    });
    this.status = "finished";
    this.finishedAt = new Date(this.now()).toISOString();
    this.audit("finish", { ranking, payouts: plan.payouts, rakeCents: plan.rakeCents });
    this.changed();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Système suisse
  // ═══════════════════════════════════════════════════════════════════════════
  private totalRounds = 0;

  /** Rondes jouées pour n joueurs : le choix du créateur, borné à n − 1 (sinon des rencontres se répéteraient). */
  private plannedRounds(n: number): number {
    return Math.min(this.cfg.swissRounds || defaultSwissRounds(n), Math.max(1, n - 1));
  }

  private async startSwiss(players: Entry[]): Promise<void> {
    this.totalRounds = this.plannedRounds(players.length);
    this.rounds = [];
    this.audit("start", { system: "swiss", rounds: this.totalRounds, seeds: players.map((p) => ({ userId: p.userId, seed: p.seed, rating: p.rating })) });
    try {
      await this.persistNow();
    } catch (e) {
      console.error(`[sng ${this.id}] persistance impossible au démarrage, annulation`, e);
      return this.cancel("persistence_error");
    }
    this.emit();
    await this.advanceSwiss();
  }

  private swissResults(): { results: SwissResult[]; byes: string[] } {
    const results: SwissResult[] = [];
    const byes: string[] = [];
    for (const m of this.rounds.flat()) {
      if (m.result === "bye") byes.push(m.p1!);
      else if (m.status === "done" && m.result) results.push({ white: m.p1!, black: m.p2!, w2: m.result === "1-0" ? 2 : m.result === "0-1" ? 0 : 1 });
    }
    return { results, byes };
  }

  private swissTable(): SwissStanding[] {
    const { results, byes } = this.swissResults();
    const players = [...this.entries.values()].filter((e) => e.seed !== null).map((e) => ({ id: e.userId, seed: e.seed! }));
    return swissStandings(players, results, byes);
  }

  /** échéance de la ronde suivante (pause entre les rondes), pour l'affichage */
  private nextRoundAt: number | null = null;

  /** Ronde terminée : on apparie la suivante (après la pause), ou on clôture après la dernière. */
  private async advanceSwiss(paused = false): Promise<void> {
    if (this.status !== "running") return;
    const last = this.rounds.at(-1);
    if (last && !last.every((m) => m.status === "done")) return;
    if (this.rounds.length >= this.totalRounds) {
      if (!this.finishing) { this.finishing = true; await this.finishSwiss(); }
      return;
    }
    const pause = this.ports.swissPauseMs ?? 0;
    if (last && pause > 0 && !paused) {
      if (this.nextRoundAt !== null) return; // déjà programmée
      this.nextRoundAt = this.now() + pause;
      this.changed();
      setTimeout(() => { void this.advanceSwiss(true).catch((e) => console.error(`[sng ${this.id}] ronde suivante`, e)); }, pause).unref?.();
      return;
    }
    this.nextRoundAt = null;
    const table = new Map(this.swissTable().map((r) => [r.id, r]));
    const live = [...this.entries.values()].filter((e) => e.seed !== null && !e.withdrawn);
    const pr = pairRound(live.map((e) => ({
      id: e.userId, seed: e.seed!, pts2: table.get(e.userId)?.pts2 ?? 0, opponents: e.opponents, colors: e.colors, hadBye: e.hadBye,
    })), this.random);
    const round = this.rounds.length + 1;
    const matches: Match[] = pr.boards.map(([w, b], slot) => ({ round, slot, p1: w, p2: b, winner: null, status: "pending", games: [], result: null }));
    for (const [w, b] of pr.boards) {
      const ew = this.entries.get(w)!, eb = this.entries.get(b)!;
      ew.opponents.push(b); eb.opponents.push(w); ew.colors.push("w"); eb.colors.push("b");
    }
    if (pr.bye) {
      const e = this.entries.get(pr.bye)!;
      e.hadBye = true; e.colors.push("-");
      matches.push({ round, slot: matches.length, p1: pr.bye, p2: null, winner: pr.bye, status: "done", games: [], result: "bye" });
    }
    this.rounds.push(matches);
    this.audit("pairing", { round, boards: pr.boards, bye: pr.bye });
    for (const m of matches) if (m.p2) await this.startGame(m, "main");
    this.changed();
    // ronde composée d'un seul exempt (impossible au-delà de 2 joueurs) : on enchaîne
    if (matches.every((m) => m.status === "done")) await this.advanceSwiss();
  }

  private async finishSwiss(): Promise<void> {
    const table = this.swissTable();
    const ranking = table.map((r) => r.id);
    this.entries.get(ranking[0]!)!.status = "winner";
    const plan = settleTournament(this.cfg.buyInCents, this.entrants, ranking, this.cfg.payoutBps, this.cfg.rakeBps, this.cfg.sponsorAddedCents);
    if (plan.potCents > 0) {
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
    for (const r of table) {
      const e = this.entries.get(r.id)!;
      e.finalRank = r.rank;
      e.payoutCents = plan.payouts[r.id] ?? 0;
      e.status = r.rank === 1 ? "winner" : "eliminated";
    }
    this.status = "finished";
    this.finishedAt = new Date(this.now()).toISOString();
    this.audit("finish", { ranking, payouts: plan.payouts, rakeCents: plan.rakeCents });
    this.changed();
  }

  private async finish(final: Match): Promise<void> {
    const winner = final.winner!;
    const finalist = final.p1 === winner ? final.p2! : final.p1!;
    const others = [...this.entries.values()]
      .filter((e) => e.status === "eliminated" && e.userId !== finalist)
      .sort((a, b) => b.eliminatedRound! - a.eliminatedRound! || a.seed! - b.seed!);
    const ranking = [winner, finalist, ...others.map((e) => e.userId)];

    // le résultat sportif est acquis : le vainqueur est libre tout de suite (duels, autre tournoi),
    // même si le paiement des gains doit être rejoué
    this.entries.get(winner)!.status = "winner";
    const plan = settleTournament(
      this.cfg.buyInCents, this.entrants, ranking, this.cfg.payoutBps, this.cfg.rakeBps, this.cfg.sponsorAddedCents,
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
    const field = this.entrants || this.cfg.size; // après le départ : les joueurs réellement engagés
    const rake = this.status === "finished" ? this.rakeCents : computeRake(this.cfg.buyInCents * field, this.cfg.rakeBps);
    const swiss = this.cfg.system === "swiss";
    const arena = this.cfg.system === "arena";
    const table = swiss && this.rounds.length ? new Map(this.swissTable().map((r) => [r.id, r])) : null;
    const aScores = arena ? arenaScores([...this.entries.keys()], this.arenaGames()) : null;
    return {
      id: this.id, formatId: this.cfg.formatId, createdBy: this.cfg.createdBy, name: this.cfg.name,
      size: this.cfg.size, timeControl: this.cfg.timeControl,
      currency: this.cfg.currency, buyInCents: this.cfg.buyInCents, sponsorAddedCents: this.cfg.sponsorAddedCents,
      rakeBps: this.cfg.rakeBps, payoutBps: [...this.cfg.payoutBps], status: this.status,
      ...(swiss && this.nextRoundAt ? { nextRoundAt: new Date(this.nextRoundAt).toISOString() } : {}),
      ...(this.cfg.startsAt ? { startsAt: this.cfg.startsAt } : {}),
      ...(this.cfg.repeatWeekly ? { repeatWeekly: true } : {}),
      ...(this.cfg.club ? { club: this.cfg.club } : {}),
      ...(this.cfg.club && this.cfg.membersOnly ? { membersOnly: true } : {}),
      ...(this.cfg.teamBattle ? { teamBattle: {
        leaders: this.cfg.teamBattle.leaders,
        teams: teamStandings(aScores ?? new Map(), new Map([...this.entries.values()].filter((e) => e.team && ACTIVE_ENTRY.has(e.status)).map((e) => [e.userId, e.team!])), this.cfg.teamBattle.teams, this.cfg.teamBattle.leaders),
      } } : {}),
      ...(arena ? { system: "arena" as const, arenaMinutes: this.cfg.arenaMinutes, ...(this.arenaEndAt ? { arenaEndsAt: new Date(this.arenaEndAt).toISOString() } : {}) } : {}),
      ...(swiss ? { system: "swiss" as const, swissRounds: this.cfg.swissRounds, totalRounds: this.totalRounds || this.plannedRounds(this.cfg.size) } : {}),
      players: [...this.entries.values()]
        .filter((e) => e.status !== "unregistered")
        .sort((a, b) => (a.seed ?? 999) - (b.seed ?? 999) || a.registeredSeq - b.registeredSeq)
        .map((e) => ({
          userId: e.userId, rating: e.rating, seed: e.seed, status: e.status,
          eliminatedRound: e.eliminatedRound, finalRank: e.finalRank, payoutCents: e.payoutCents,
          ...(e.team ? { team: e.team } : {}),
          ...(e.withdrawn ? { withdrawn: true } : {}),
          ...(arena && e.seed !== null ? (() => {
            const sc = aScores!.get(e.userId);
            return { points: sc?.score ?? 0, fire: sc?.fire ?? false, sheet: sc?.sheet ?? [], ...(e.paused ? { paused: true } : {}) };
          })() : {}),
          ...(swiss && e.seed !== null ? {
            points: (table?.get(e.userId)?.pts2 ?? 0) / 2,
            buchholz: (table?.get(e.userId)?.buchholz2 ?? 0) / 2,
            sonnebornBerger: (table?.get(e.userId)?.sb4 ?? 0) / 4,
          } : {}),
        })),
      rounds: this.rounds.map((r) => r.map((m): SngMatchView => ({
        round: m.round, slot: m.slot, p1: m.p1, p2: m.p2, winner: m.winner, status: m.status,
        ...(swiss || arena ? { result: m.result ?? null } : {}),
        games: m.games.filter((g) => g.gameId).map((g): SngGameView => ({
          gameId: g.gameId!, white: g.white, black: g.black, kind: g.kind, result: g.result, termination: g.termination,
          ...(g.berserk ? { berserk: g.berserk } : {}), ...(g.plies !== undefined ? { plies: g.plies } : {}),
        })),
      }))),
      currentRound: swiss ? this.rounds.length : arena ? (this.rounds.length ? 1 : 0) : this.rounds.findIndex((r) => r.some((m) => m.status !== "done")) + 1,
      prizePoolCents: this.cfg.buyInCents * field - rake + this.cfg.sponsorAddedCents,
      rakeCents: this.status === "finished" ? this.rakeCents : 0,
      cancelReason: this.cancelReason,
      createdAt: this.createdAt, startedAt: this.startedAt, finishedAt: this.finishedAt,
    };
  }

  /** Enregistre l'état tout de suite (ex. tournoi officiel créé sans inscrit : son lien reste valable après une mise en ligne). */
  save(): Promise<void> { return this.persistNow(); }

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
